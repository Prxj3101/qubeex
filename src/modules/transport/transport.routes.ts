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
import { forgetTrackerCache, getFixes, isOnline } from "../../services/gps.service";

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

const stopSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  pickupTime: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM").or(z.literal("")).default(""),
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
}).strict();
const assignSchema = z.object({
  busId: z.string().uuid(),
  stopId: z.string().uuid().nullable().default(null),
}).strict();

const ROUTE_SELECT = {
  id: true, name: true, color: true,
  stops: { orderBy: { sequence: "asc" as const }, select: { id: true, name: true, lat: true, lng: true, sequence: true, pickupTime: true } },
};
const BUS_SELECT = {
  id: true, name: true, plateNumber: true, trackerId: true, driverName: true, driverPhone: true, capacity: true, routeId: true,
  route: { select: { id: true, name: true, color: true } },
  _count: { select: { students: true } },
};

// ── Overview: everything the Transport page needs in one call ────────────────
router.get("/overview", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const [routes, buses] = await Promise.all([
      academicDb().transportRoute.findMany({ where: { institutionId }, orderBy: { name: "asc" }, select: { ...ROUTE_SELECT, _count: { select: { buses: true } } } }),
      academicDb().transportBus.findMany({ where: { institutionId }, orderBy: { name: "asc" }, select: BUS_SELECT }),
    ]);
    res.json({ success: true, data: { routes, buses } });
  } catch (err) { next(err); }
});

// ── Live positions (the map polls this every few seconds) ────────────────────
router.get("/live", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const buses = await academicDb().transportBus.findMany({
      where: { institutionId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, plateNumber: true, trackerId: true, routeId: true, route: { select: { name: true, color: true } } },
    });
    const fixes = await getFixes(buses.map((b) => b.trackerId ?? ""));
    const now = Date.now();
    res.json({
      success: true,
      data: buses.map((b) => {
        const fix = b.trackerId ? fixes.get(b.trackerId) ?? null : null;
        return { busId: b.id, name: b.name, plateNumber: b.plateNumber, routeId: b.routeId, route: b.route, hasTracker: !!b.trackerId, position: fix, online: isOnline(fix, now) };
      }),
      serverTime: new Date(now).toISOString(),
    });
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
        stops: { create: input.stops.map((s, i) => ({ institutionId, name: clean(s.name), lat: s.lat, lng: s.lng, pickupTime: s.pickupTime, sequence: i })) },
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
        const fields = { name: clean(s.name), lat: s.lat, lng: s.lng, pickupTime: s.pickupTime, sequence: i };
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
      const data = await academicDb().transportBus.create({ data: { ...input, trackerId, name, nameKey: name.toLowerCase(), institutionId }, select: BUS_SELECT });
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
    const bus = await academicDb().transportBus.findFirst({ where: { id, institutionId }, select: { trackerId: true } });
    if (!bus) throw new NotFoundError("Bus not found");
    await checkRoute(institutionId, input.routeId);
    if (trackerId && trackerId !== bus.trackerId && (await academicDb().transportBus.count({ where: { trackerId } }))) throw new ConflictError("Another bus already uses this tracker");
    await claimTracker(institutionId, trackerId, bus.trackerId);
    const data = await academicDb().transportBus.update({ where: { id }, data: { ...input, trackerId, name, nameKey: name.toLowerCase() }, select: BUS_SELECT });
    res.json({ success: true, data });
  } catch (err) { handleError(err, next); }
});

router.delete("/buses/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const id = idSchema.parse(req.params.id);
    const bus = await academicDb().transportBus.findFirst({ where: { id, institutionId }, select: { trackerId: true } });
    if (!bus) throw new NotFoundError("Bus not found");
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
        stop: { select: { id: true, name: true } },
        student: { select: { id: true, userId: true, studentId: true, rollNo: true, division: { select: { name: true, standard: { select: { name: true } } } } } },
      },
    });
    const users = await resolveUsers(rows.map((r) => r.student.userId), { id: true, name: true });
    const data = rows
      .map((r) => ({
        studentId: r.student.id,
        admissionNo: r.student.studentId,
        name: users.get(r.student.userId)?.name ?? "",
        rollNo: r.student.rollNo,
        className: r.student.division ? `${r.student.division.standard.name} ${r.student.division.name}` : "",
        stop: r.stop,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.put("/students/:studentId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const studentId = idSchema.parse(req.params.studentId);
    const { busId, stopId } = assignSchema.parse(req.body);
    const db = academicDb();
    const [student, bus] = await Promise.all([
      db.student.count({ where: { id: studentId, institutionId } }),
      db.transportBus.findFirst({ where: { id: busId, institutionId }, select: { routeId: true } }),
    ]);
    if (!student) throw new NotFoundError("Student not found");
    if (!bus) throw new NotFoundError("Bus not found");
    if (stopId && !(bus.routeId && (await db.transportStop.count({ where: { id: stopId, routeId: bus.routeId } })))) {
      throw new BadRequestError("This stop is not on the bus's route");
    }
    await db.studentTransport.upsert({
      where: { studentId },
      create: { institutionId, studentId, busId, stopId },
      update: { busId, stopId },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete("/students/:studentId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await academicDb().studentTransport.deleteMany({ where: { studentId: idSchema.parse(req.params.studentId), institutionId: institution(req) } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
