import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { requirePermission } from "../../middlewares/requirePermission.middleware";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";
import { resolveUsers } from "../../services/userLookup.service";
import { generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { forgetTrackerCache, getFixes, isOnline } from "../../services/gps.service";
import { busTrip } from "../../services/tripProgress";
import { demoStatus, SIM_PREFIX, startDemo, stopDemo } from "../../services/busDemo.service";
import { assignStudentBus, BUS_REQUEST_KEY, busFeeMonths, removeStudentBus, renameBusOnFeeCards } from "../../services/studentBus.service";

// Admin: Transport (routes, stops, buses, who rides which bus) + live bus map.
const router = Router();
router.use(authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware, requirePermission("TRANSPORT"));

const institution = (req: AuthRequest) => {
  if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account");
  return req.user.institutionId;
};
const idSchema = z.string().uuid();
const clean = (v: string) => v.trim().replace(/\s+/g, " ");
const handleError = (err: unknown, next: NextFunction) => {
  const code = (err as { code?: string })?.code;
  if (code === "P2002") return next(new ConflictError("This name is already used"));
  next(err);
};

const hhmm = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM").or(z.literal("")).default("");
const stopSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  pickupTime: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM").or(z.literal("")).default(""),
  monthlyFee: z.number().int().min(0).max(100000).nullable().default(null),
}).strict();
const routeSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).default("#DA7756"),
  stops: z.array(stopSchema).max(60).default([]),
}).strict();
const busSchema = z.object({
  name: z.string().trim().min(1).max(40),
  plateNumber: z.string().trim().max(20).default(""),
  trackerId: z.string().trim().max(64).nullable().default(null),
  driverName: z.string().trim().max(60).default(""),
  driverPhone: z.string().trim().max(20).default(""),
  capacity: z.number().int().min(1).max(200).nullable().default(null),
  routeId: z.string().uuid().nullable().default(null),
  // Timings: pickup = bus leaves the first stop, drop = bus leaves school.
  morningShift: z.boolean().default(true),
  morningPickup: hhmm,
  morningDrop: hhmm,
  afternoonShift: z.boolean().default(false),
  afternoonPickup: hhmm,
  afternoonDrop: hhmm,
}).strict().superRefine((b, ctx) => {
  if (!b.morningShift && !b.afternoonShift) ctx.addIssue({ code: "custom", path: ["morningShift"], message: "Pick at least one shift for this bus" });
  if (b.morningShift && (!b.morningPickup || !b.morningDrop)) ctx.addIssue({ code: "custom", path: ["morningPickup"], message: "Add the morning pickup and drop times" });
  if (b.afternoonShift && (!b.afternoonPickup || !b.afternoonDrop)) ctx.addIssue({ code: "custom", path: ["afternoonPickup"], message: "Add the afternoon pickup and drop times" });
});
const assignSchema = z.object({
  busId: z.string().uuid(),
  stopId: z.string().uuid().nullable().default(null),
  shift: z.enum(["MORNING", "AFTERNOON"]).optional(),
  months: z.array(z.string().min(1)).max(24).optional(), // fee months that carry the bus fee (default: months to come)
}).strict();

const ROUTE_SELECT = {
  id: true, name: true, color: true,
  stops: { orderBy: { sequence: "asc" as const }, select: { id: true, name: true, lat: true, lng: true, sequence: true, pickupTime: true, monthlyFee: true } },
};
const BUS_SELECT = {
  id: true, name: true, plateNumber: true, trackerId: true, driverName: true, driverPhone: true, capacity: true, routeId: true,
  morningShift: true, morningPickup: true, morningDrop: true, afternoonShift: true, afternoonPickup: true, afternoonDrop: true,
  route: { select: { id: true, name: true, color: true } },
  _count: { select: { students: true } },
};

// ── Overview: everything the Transport page needs in one call ────────────────
router.get("/overview", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const [routes, buses, inst] = await Promise.all([
      academicDb().transportRoute.findMany({ where: { institutionId }, orderBy: { name: "asc" }, select: { ...ROUTE_SELECT, _count: { select: { buses: true } } } }),
      academicDb().transportBus.findMany({ where: { institutionId }, orderBy: { name: "asc" }, select: BUS_SELECT }),
      prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true, schoolLat: true, schoolLng: true } }),
    ]);
    const school = inst?.schoolLat != null && inst.schoolLng != null ? { name: inst.name, lat: inst.schoolLat, lng: inst.schoolLng } : null;
    res.json({ success: true, data: { routes, buses, school } });
  } catch (err) { next(err); }
});

// ── Live positions (the map polls this every few seconds) ────────────────────
router.get("/live", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const buses = await academicDb().transportBus.findMany({
      where: { institutionId },
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, plateNumber: true, trackerId: true, routeId: true,
        morningShift: true, afternoonShift: true, morningPickup: true, morningDrop: true, afternoonPickup: true, afternoonDrop: true,
        route: { select: { name: true, color: true, stops: { orderBy: { sequence: "asc" }, select: { name: true, lat: true, lng: true } } } },
      },
    });
    const [fixes, inst] = await Promise.all([
      getFixes(buses.map((b) => b.trackerId ?? "")),
      prisma.institution.findUnique({ where: { id: institutionId }, select: { schoolLat: true, schoolLng: true } }),
    ]);
    const school = inst?.schoolLat != null && inst.schoolLng != null ? { lat: inst.schoolLat, lng: inst.schoolLng } : null;
    const now = Date.now();
    const data = await Promise.all(buses.map(async (b) => {
      const fix = b.trackerId ? fixes.get(b.trackerId) ?? null : null;
      const online = isOnline(fix, now);
      // where it is on its trip: "At Patankar", "Going to 4th Road · 2/5 stops", "Reached school"
      const trip = online && fix && b.trackerId && b.route ? await busTrip(b.trackerId, fix, b.route.stops, school, b).catch(() => null) : null;
      return {
        busId: b.id, name: b.name, plateNumber: b.plateNumber, routeId: b.routeId,
        route: b.route ? { name: b.route.name, color: b.route.color } : null,
        hasTracker: !!b.trackerId, position: fix, online, trip,
      };
    }));
    res.json({
      success: true,
      data,
      serverTime: new Date(now).toISOString(),
    });
  } catch (err) { next(err); }
});

// ── Demo buses (for showing the product): moves only "sim-" buses ───────────
router.get("/demo", (req: AuthRequest, res: Response) => {
  res.json({ success: true, data: demoStatus(institution(req)) });
});

router.post("/demo/start", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const [inst, buses] = await Promise.all([
      prisma.institution.findUnique({ where: { id: institutionId }, select: { schoolLat: true, schoolLng: true } }),
      academicDb().transportBus.findMany({
        where: { institutionId, trackerId: { startsWith: SIM_PREFIX }, routeId: { not: null } },
        orderBy: { name: "asc" },
        select: { name: true, trackerId: true, route: { select: { stops: { orderBy: { sequence: "asc" }, select: { name: true, lat: true, lng: true } } } } },
      }),
    ]);
    if (inst?.schoolLat == null || inst.schoolLng == null) throw new BadRequestError("Set the school location first");
    const ready = buses.filter((b) => b.trackerId && b.route?.stops.length);
    if (!ready.length) throw new BadRequestError(`No demo buses. Give a bus a route and a tracker id starting with "${SIM_PREFIX}", e.g. ${SIM_PREFIX}bus-1`);
    const data = startDemo(institutionId, { lat: inst.schoolLat, lng: inst.schoolLng }, ready.map((b) => ({ trackerId: b.trackerId!, name: b.name, stops: b.route!.stops })));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post("/demo/stop", (req: AuthRequest, res: Response) => {
  stopDemo(institution(req));
  res.json({ success: true, data: demoStatus(institution(req)) });
});

// ── School location (where every route ends) ────────────────────────────────
const schoolSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();
router.put("/school", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { lat, lng } = schoolSchema.parse(req.body);
    await prisma.institution.update({ where: { id: institution(req) }, data: { schoolLat: lat, schoolLng: lng } });
    res.json({ success: true });
  } catch (err) { next(err); }
});
router.delete("/school", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await prisma.institution.update({ where: { id: institution(req) }, data: { schoolLat: null, schoolLng: null } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Routes + stops ───────────────────────────────────────────────────────────
router.post("/routes", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const input = routeSchema.parse(req.body);
    const name = clean(input.name);
    const data = await academicDb().transportRoute.create({
      data: {
        institutionId, name, nameKey: name.toLowerCase(), color: input.color,
        stops: { create: input.stops.map((s, i) => ({ institutionId, name: clean(s.name), lat: s.lat, lng: s.lng, pickupTime: s.pickupTime, monthlyFee: s.monthlyFee, sequence: i })) },
      },
      select: ROUTE_SELECT,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { handleError(err, next); }
});

// Saves the whole route. Stops sent with an id are updated (so students keep
// their stop), stops without an id are added, and stops left out are removed.
router.put("/routes/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const id = idSchema.parse(req.params.id);
    const input = routeSchema.parse(req.body);
    const name = clean(input.name);
    const db = academicDb();
    const existing = await db.transportRoute.findFirst({ where: { id, institutionId }, select: { stops: { select: { id: true } } } });
    if (!existing) throw new NotFoundError("Route not found");
    const ownIds = new Set(existing.stops.map((s) => s.id));
    const keep = input.stops.filter((s) => s.id && ownIds.has(s.id)).map((s) => s.id as string);
    await db.$transaction([
      db.transportRoute.update({ where: { id }, data: { name, nameKey: name.toLowerCase(), color: input.color } }),
      db.transportStop.deleteMany({ where: { routeId: id, id: { notIn: keep } } }),
      ...input.stops.map((s, i) => {
        const fields = { name: clean(s.name), lat: s.lat, lng: s.lng, pickupTime: s.pickupTime, monthlyFee: s.monthlyFee, sequence: i };
        return s.id && ownIds.has(s.id)
          ? db.transportStop.update({ where: { id: s.id }, data: fields })
          : db.transportStop.create({ data: { ...fields, institutionId, routeId: id } });
      }),
    ]);
    const data = await db.transportRoute.findFirst({ where: { id, institutionId }, select: ROUTE_SELECT });
    res.json({ success: true, data });
  } catch (err) { handleError(err, next); }
});

router.delete("/routes/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await academicDb().transportRoute.deleteMany({ where: { id: idSchema.parse(req.params.id), institutionId: institution(req) } });
    if (!result.count) throw new NotFoundError("Route not found");
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Buses ────────────────────────────────────────────────────────────────────
// A tracker id can belong to one school only (central GpsTracker registry).
async function claimTracker(institutionId: string, trackerId: string | null, previous: string | null) {
  if (trackerId === previous) return;
  if (trackerId) {
    const owner = await prisma.gpsTracker.findUnique({ where: { trackerId }, select: { institutionId: true } });
    if (owner && owner.institutionId !== institutionId) throw new ConflictError("This tracker is already registered by another school");
    if (!owner) await prisma.gpsTracker.create({ data: { trackerId, institutionId } });
  }
  if (previous) await prisma.gpsTracker.deleteMany({ where: { trackerId: previous, institutionId } });
  forgetTrackerCache();
}

// Times of a switched-off shift are cleared so they don't show anywhere.
function timings<T extends z.infer<typeof busSchema>>(b: T): T {
  return {
    ...b,
    morningPickup: b.morningShift ? b.morningPickup : "", morningDrop: b.morningShift ? b.morningDrop : "",
    afternoonPickup: b.afternoonShift ? b.afternoonPickup : "", afternoonDrop: b.afternoonShift ? b.afternoonDrop : "",
  };
}

async function checkRoute(institutionId: string, routeId: string | null) {
  if (routeId && !(await academicDb().transportRoute.count({ where: { id: routeId, institutionId } }))) throw new BadRequestError("Route not found");
}

router.post("/buses", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const input = busSchema.parse(req.body);
    const name = clean(input.name);
    const trackerId = input.trackerId || null;
    await checkRoute(institutionId, input.routeId);
    if (trackerId && (await academicDb().transportBus.count({ where: { trackerId } }))) throw new ConflictError("Another bus already uses this tracker");
    await claimTracker(institutionId, trackerId, null);
    try {
      const data = await academicDb().transportBus.create({ data: { ...timings(input), trackerId, name, nameKey: name.toLowerCase(), institutionId }, select: BUS_SELECT });
      res.status(201).json({ success: true, data });
    } catch (err) {
      await claimTracker(institutionId, null, trackerId).catch(() => {}); // undo the claim
      throw err;
    }
  } catch (err) { handleError(err, next); }
});

router.put("/buses/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const id = idSchema.parse(req.params.id);
    const input = busSchema.parse(req.body);
    const name = clean(input.name);
    const trackerId = input.trackerId || null;
    const bus = await academicDb().transportBus.findFirst({ where: { id, institutionId }, select: { trackerId: true, name: true } });
    if (!bus) throw new NotFoundError("Bus not found");
    await checkRoute(institutionId, input.routeId);
    if (trackerId && trackerId !== bus.trackerId && (await academicDb().transportBus.count({ where: { trackerId } }))) throw new ConflictError("Another bus already uses this tracker");
    await claimTracker(institutionId, trackerId, bus.trackerId);
    const db = academicDb();
    const data = await db.transportBus.update({ where: { id }, data: { ...timings(input), trackerId, name, nameKey: name.toLowerCase() }, select: BUS_SELECT });
    // a shift was switched off: its riders move to the shift the bus still runs
    if (!input.morningShift) await db.studentTransport.updateMany({ where: { busId: id, shift: "MORNING" }, data: { shift: "AFTERNOON" } });
    if (!input.afternoonShift) await db.studentTransport.updateMany({ where: { busId: id, shift: "AFTERNOON" }, data: { shift: "MORNING" } });
    if (bus.name !== name) await renameBusOnFeeCards(institutionId, id, name);
    res.json({ success: true, data });
  } catch (err) { handleError(err, next); }
});

router.delete("/buses/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const id = idSchema.parse(req.params.id);
    const bus = await academicDb().transportBus.findFirst({ where: { id, institutionId }, select: { trackerId: true } });
    if (!bus) throw new NotFoundError("Bus not found");
    // riders come off the bus properly, so their fee cards stop the bus fee too
    const riders = await academicDb().studentTransport.findMany({ where: { busId: id, institutionId }, select: { studentId: true } });
    for (const r of riders) await removeStudentBus(institutionId, r.studentId);
    await academicDb().transportBus.delete({ where: { id } });
    await claimTracker(institutionId, null, bus.trackerId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Students on a bus ────────────────────────────────────────────────────────
router.get("/buses/:id/students", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const busId = idSchema.parse(req.params.id);
    const rows = await academicDb().studentTransport.findMany({
      where: { busId, institutionId },
      select: {
        shift: true,
        stop: { select: { id: true, name: true } },
        student: { select: { id: true, userId: true, studentId: true, rollNo: true, avatarUrl: true, division: { select: { name: true, standard: { select: { name: true } } } } } },
      },
    });
    const users = await resolveUsers(rows.map((r) => r.student.userId), { id: true, name: true });
    const riderPhotos = await generateSignedAvatarUrlsBatch(rows.map((r) => r.student.avatarUrl));
    const data = rows
      .map((r) => ({
        studentId: r.student.id,
        admissionNo: r.student.studentId,
        name: users.get(r.student.userId)?.name ?? "",
        rollNo: r.student.rollNo,
        avatarUrl: r.student.avatarUrl ? (riderPhotos[r.student.avatarUrl] ?? r.student.avatarUrl) : null,
        className: r.student.division ? `${r.student.division.standard.name} ${r.student.division.name}` : "",
        stop: r.stop,
        shift: r.shift,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// Find students to put on a bus (by name or admission number).
router.get("/students/search", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const q = z.string().trim().min(1).max(60).parse(req.query.q);
    const users = await prisma.user.findMany({
      where: { institutionId, role: "STUDENT", name: { contains: q, mode: "insensitive" } },
      select: { id: true, name: true },
      take: 30,
    });
    const students = await academicDb().student.findMany({
      where: { institutionId, OR: [{ userId: { in: users.map((u) => u.id) } }, { studentId: { contains: q, mode: "insensitive" } }] },
      select: {
        id: true, userId: true, studentId: true, avatarUrl: true,
        division: { select: { name: true, standard: { select: { name: true } } } },
        transport: { select: { bus: { select: { id: true, name: true } } } },
      },
      take: 30,
    });
    const foundPhotos = await generateSignedAvatarUrlsBatch(students.map((s) => s.avatarUrl));
    const names = new Map(users.map((u) => [u.id, u.name ?? ""]));
    const missing = students.filter((s) => !names.has(s.userId)).map((s) => s.userId);
    if (missing.length) (await resolveUsers(missing, { id: true, name: true })).forEach((u, id) => names.set(id, u.name ?? ""));
    res.json({
      success: true,
      data: students
        .map((s) => ({
          studentId: s.id,
          admissionNo: s.studentId,
          name: names.get(s.userId) ?? "",
          avatarUrl: s.avatarUrl ? (foundPhotos[s.avatarUrl] ?? s.avatarUrl) : null,
          className: s.division ? `${s.division.standard.name} ${s.division.name}` : "",
          currentBus: s.transport?.bus ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20),
    });
  } catch (err) { next(err); }
});

router.put("/students/:studentId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { busId, stopId, shift, months } = assignSchema.parse(req.body);
    // also turns on the bus fee on the student's fee card (see studentBus.service)
    await assignStudentBus(institution(req), idSchema.parse(req.params.studentId), { busId, stopId, shift, months });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// The student's fee months, for picking which carry the bus fee.
router.get("/students/:studentId/fee-months", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await busFeeMonths(institution(req), idSchema.parse(req.params.studentId)) });
  } catch (err) { next(err); }
});

router.delete("/students/:studentId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await removeStudentBus(institution(req), idSchema.parse(req.params.studentId));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Waiting list: students who need a bus but don't have one yet ────────────
// • asked for the bus at admission (BUS_REQUEST_KEY on the student), or
// • bus turned on in their fee card before buses were linked (old "Bus No.").
type WaitingStudent = { studentId: string; divisionId: string | null; admissionNo: string; name: string; className: string; rollNo: string | null; avatarUrl: string | null; reason: "ADMISSION" | "FEE_CARD"; note: string };

function waitingReason(fields: Record<string, string> | null): { reason: WaitingStudent["reason"]; note: string } | null {
  if (!fields) return null;
  const req = fields[BUS_REQUEST_KEY];
  if (req === "FEE_CARD") return { reason: "FEE_CARD", note: "Bus to be decided" };
  if (req) return { reason: "ADMISSION", note: req === "Yes" ? "" : req };
  // the fee card's Bus field keeps `${id}-enabled` next to `${id}-number`
  for (const key of Object.keys(fields)) {
    if (!key.endsWith("-enabled") || fields[key] !== "true") continue;
    const id = key.slice(0, -"-enabled".length);
    if (id === "f-bus" || `${id}-number` in fields) return { reason: "FEE_CARD", note: fields[`${id}-number`] ? `Was Bus No. ${fields[`${id}-number`]}` : "" };
  }
  return null;
}

router.get("/waiting", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const students = await academicDb().student.findMany({
      where: { institutionId, transport: null, status: { notIn: ["WITHDRAWN", "GRADUATED", "INACTIVE"] } },
      select: { id: true, userId: true, studentId: true, divisionId: true, rollNo: true, avatarUrl: true, extraDetailFields: true, division: { select: { name: true, standard: { select: { name: true } } } } },
    });
    const waiting = students
      .map((s) => ({ s, why: waitingReason(s.extraDetailFields as Record<string, string> | null) }))
      .filter((x): x is { s: typeof students[number]; why: NonNullable<ReturnType<typeof waitingReason>> } => !!x.why);
    const [users, signed] = await Promise.all([
      resolveUsers(waiting.map((x) => x.s.userId), { id: true, name: true }),
      generateSignedAvatarUrlsBatch(waiting.map((x) => x.s.avatarUrl)),
    ]);
    const data: WaitingStudent[] = waiting
      .map(({ s, why }) => ({
        studentId: s.id,
        divisionId: s.divisionId,
        admissionNo: s.studentId,
        name: users.get(s.userId)?.name ?? "",
        className: s.division ? `${s.division.standard.name} ${s.division.name}` : "",
        rollNo: s.rollNo,
        avatarUrl: s.avatarUrl ? (signed[s.avatarUrl] ?? s.avatarUrl) : null,
        ...why,
      }))
      .sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// Take a student off the waiting list without giving a bus ("doesn't need it").
router.delete("/waiting/:studentId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const studentId = idSchema.parse(req.params.studentId);
    const student = await academicDb().student.findFirst({ where: { id: studentId, institutionId }, select: { extraDetailFields: true } });
    if (!student) throw new NotFoundError("Student not found");
    const fields = { ...((student.extraDetailFields as Record<string, string> | null) ?? {}) };
    if (fields[BUS_REQUEST_KEY]) {
      delete fields[BUS_REQUEST_KEY];
      await academicDb().student.update({ where: { id: studentId }, data: { extraDetailFields: fields } });
    } else {
      await removeStudentBus(institutionId, studentId); // old fee-card bus: turn it off (old months keep their fee)
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
