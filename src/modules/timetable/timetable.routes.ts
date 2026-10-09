import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { requirePermission } from "../../middlewares/requirePermission.middleware";
import { TimetableConflictError, resolveYear } from "./timetable.common";
import { assertAcademicYearAccess } from "../../utils/academicYearAccess";
import type { Actor } from "./timetable.notify";
import { audit } from "./timetable.notify";
import * as S from "./timetable.schema";
import * as setup from "./timetable.setup.service";
import * as studio from "./timetable.studio.service";
import * as entries from "./timetable.entries.service";
import * as gen from "./timetable.generate.service";
import * as changes from "./timetable.changes.service";
import * as views from "./timetable.views.service";
import { exportTimetable } from "./timetable.export.service";

const router = Router();

const BASE = [authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware];
const READ = [...BASE, requirePermission("TIMETABLE_VIEW", "TIMETABLE_MANAGE")];
const WRITE = [...BASE, requirePermission("TIMETABLE_MANAGE")];

type Ctx = { institutionId: string; actor: Actor; year: Awaited<ReturnType<typeof resolveYear>> };

async function ctxOf(req: AuthRequest): Promise<Ctx> {
  const u = req.user!;
  if (!u.institutionId) throw { status: 400, message: "No institution" };
  const { academicYearId } = S.yearQuery.parse(req.query);
  const year = await resolveYear(academicYearId, u.institutionId, { role: u.role, userId: u.userId });
  return { institutionId: u.institutionId, year, actor: { userId: u.userId, role: u.role, institutionId: u.institutionId, ip: req.ip } };
}

/** Wrap a handler: JSON success envelope, 409 + conflict list on TimetableConflictError, everything else to errorHandler. */
const h = (fn: (req: AuthRequest, c: Ctx) => Promise<unknown>, status = 200) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const data = await fn(req, await ctxOf(req));
      res.status(status).json({ success: true, data });
    } catch (err) {
      if (err instanceof TimetableConflictError) {
        res.status(409).json({ success: false, error: err.message, conflicts: err.conflicts, canForce: true });
        return;
      }
      next(err);
    }
  };

const param = (req: AuthRequest, name: string) => req.params[name] as string;

// ── Setup ──────────────────────────────────────────────────────────────────────
router.get("/setup", ...READ, h((_r, c) => setup.getSetup(c.institutionId, c.year)));
router.put("/settings", ...WRITE, h(async (r, c) => {
  const out = await setup.setWorkingDays(c.institutionId, c.year, S.workingDaysSchema.parse(r.body).workingDays);
  audit(c.actor, "TIMETABLE_SETTINGS_UPDATED", `Working days set for ${c.year.label}`, { academicYearId: c.year.id, workingDays: out.workingDays.join(",") });
  return out;
}));

router.post("/slots", ...WRITE, h(async (r, c) => {
  const slot = await setup.createSlot(c.institutionId, c.year, S.slotBodySchema.parse(r.body));
  audit(c.actor, "TIMETABLE_PERIOD_CREATED", `Added period ${slot.name}`, { academicYearId: c.year.id });
  return slot;
}, 201));
router.patch("/slots/reorder", ...WRITE, h(async (r, c) => { await setup.reorderSlots(c.institutionId, c.year, S.slotReorderSchema.parse(r.body).orderedIds); return {}; }));
router.post("/slots/copy-from-year", ...WRITE, h(async (r, c) => {
  const out = await setup.copyFromYear(c.institutionId, c.year, S.copyYearSchema.parse(r.body).fromAcademicYearId);
  audit(c.actor, "TIMETABLE_SETUP_COPIED", `Copied periods into ${c.year.label}`, { academicYearId: c.year.id, copied: out.copiedSlots });
  return out;
}));
router.patch("/slots/:id", ...WRITE, h((r, c) => setup.updateSlot(c.institutionId, c.year, param(r, "id"), S.slotPatchSchema.parse(r.body))));
router.delete("/slots/:id", ...WRITE, h(async (r, c) => { await setup.deleteSlot(c.institutionId, c.year, param(r, "id")); return {}; }));

router.get("/session-types", ...READ, h((_r, c) => setup.listSessionTypes(c.institutionId)));
router.post("/session-types", ...WRITE, h((r, c) => setup.createSessionType(c.institutionId, S.sessionTypeSchema.parse(r.body)), 201));
router.patch("/session-types/:id", ...WRITE, h((r, c) => setup.updateSessionType(c.institutionId, param(r, "id"), S.sessionTypePatchSchema.parse(r.body))));
router.delete("/session-types/:id", ...WRITE, h(async (r, c) => { await setup.deleteSessionType(c.institutionId, param(r, "id")); return {}; }));

router.post("/rooms", ...WRITE, h((r, c) => setup.createRoom(c.institutionId, S.roomSchema.parse(r.body)), 201));
router.patch("/rooms/:id", ...WRITE, h((r, c) => setup.updateRoom(c.institutionId, param(r, "id"), S.roomPatchSchema.parse(r.body))));
router.delete("/rooms/:id", ...WRITE, h(async (r, c) => { await setup.deleteRoom(c.institutionId, param(r, "id")); return {}; }));
router.get("/rooms/:id/unavailability", ...READ, h((r, c) => setup.getRoomUnavailability(c.institutionId, c.year, param(r, "id"))));
router.put("/rooms/:id/unavailability", ...WRITE, h(async (r, c) => { await setup.setRoomUnavailability(c.institutionId, c.year, param(r, "id"), S.cellsSchema.parse(r.body)); return {}; }));

router.get("/teachers/:id/availability", ...READ, h((r, c) => setup.getTeacherAvailability(c.institutionId, c.year, param(r, "id"))));
router.put("/teachers/:id/availability", ...WRITE, h(async (r, c) => { await setup.setTeacherAvailability(c.institutionId, c.year, param(r, "id"), S.availabilitySchema.parse(r.body)); return {}; }));
router.put("/teachers/:id/prefs", ...WRITE, h(async (r, c) => { await setup.setTeacherPrefs(c.institutionId, c.year, param(r, "id"), S.teacherPrefSchema.parse(r.body)); return {}; }));

// ── Overview / studio ──────────────────────────────────────────────────────────
router.get("/overview", ...READ, h((_r, c) => gen.listTimetableStatuses(c.institutionId, c.year)));
router.get("/conflicts", ...READ, h((r, c) => studio.getYearConflicts(c.institutionId, c.year, typeof r.query.divisionId === "string" ? r.query.divisionId : undefined)));

router.get("/divisions/:divisionId", ...READ, h((r, c) => studio.getDivisionStudio(c.institutionId, c.year, param(r, "divisionId"))));
router.put("/divisions/:divisionId/configs", ...WRITE, h(async (r, c) => {
  const out = await studio.saveConfigs(c.institutionId, c.year, param(r, "divisionId"), S.configsSchema.parse(r.body));
  audit(c.actor, "TIMETABLE_REQUIREMENTS_UPDATED", `Updated weekly requirements`, { divisionId: param(r, "divisionId"), academicYearId: c.year.id });
  return out;
}));
router.post("/divisions/:divisionId/generate", ...WRITE, h((r, c) => { const b = S.generateSchema.parse(r.body ?? {}); return gen.generateForDivision(c.institutionId, c.year, param(r, "divisionId"), b.keepLocked, c.actor, b.variation); }));
router.post("/divisions/:divisionId/status", ...WRITE, h((r, c) => gen.setStatus(c.institutionId, c.year, param(r, "divisionId"), S.statusSchema.parse(r.body), c.actor)));
router.post("/divisions/:divisionId/entries", ...WRITE, h((r, c) => entries.addEntry(c.institutionId, c.year, param(r, "divisionId"), S.entryCreateSchema.parse(r.body), c.actor), 201));
router.post("/divisions/:divisionId/clear", ...WRITE, h((r, c) => { const b = S.clearSchema.parse(r.body ?? {}); return entries.clearDivision(c.institutionId, c.year, param(r, "divisionId"), b.keepLocked, c.actor, b.dayOfWeek); }));
router.post("/divisions/:divisionId/restore", ...WRITE, h((r, c) => entries.restoreEntries(c.institutionId, c.year, param(r, "divisionId"), S.restoreSchema.parse(r.body), c.actor), 201));
router.post("/divisions/:divisionId/copy-day", ...WRITE, h((r, c) => entries.copyDay(c.institutionId, c.year, param(r, "divisionId"), S.copyDaySchema.parse(r.body), c.actor)));

router.post("/generate-bulk", ...WRITE, h((r, c) => gen.generateBulk(c.institutionId, c.year, S.generateBulkSchema.parse(r.body ?? {}), c.actor)));
router.post("/status-bulk", ...WRITE, h((r, c) => gen.setStatusBulk(c.institutionId, c.year, S.bulkStatusSchema.parse(r.body), c.actor)));
router.post("/apply-to-all", ...WRITE, h((r, c) => entries.applyToAll(c.institutionId, c.year, S.applyToAllSchema.parse(r.body), c.actor)));

router.post("/entries/move", ...WRITE, h((r, c) => entries.moveEntry(c.institutionId, c.year, S.entryMoveSchema.parse(r.body), c.actor)));
router.post("/entries/bulk-delete", ...WRITE, h((r, c) => entries.bulkDeleteEntries(c.institutionId, c.year, S.bulkDeleteSchema.parse(r.body), c.actor)));
router.post("/entries/swap", ...WRITE, h((r, c) => entries.swapEntries(c.institutionId, c.year, S.entrySwapSchema.parse(r.body), c.actor)));
router.patch("/entries/:id", ...WRITE, h((r, c) => entries.updateEntry(c.institutionId, c.year, param(r, "id"), S.entryPatchSchema.parse(r.body), c.actor)));
router.delete("/entries/:id", ...WRITE, h((r, c) => entries.deleteEntry(c.institutionId, c.year, param(r, "id"), c.actor)));
router.post("/entries/:id/lock", ...WRITE, h((r, c) => entries.setLocked(c.institutionId, c.year, param(r, "id"), true, c.actor)));
router.post("/entries/:id/unlock", ...WRITE, h((r, c) => entries.setLocked(c.institutionId, c.year, param(r, "id"), false, c.actor)));

// ── Cross-views & exports ──────────────────────────────────────────────────────
router.get("/views/master", ...READ, h((r, c) => views.adminView(c.institutionId, c.year, "master", undefined, typeof r.query.standardId === "string" ? r.query.standardId : undefined)));
router.get("/views/teacher/:id", ...READ, h((r, c) => views.adminView(c.institutionId, c.year, "teacher", param(r, "id"))));
router.get("/views/room/:id", ...READ, h((r, c) => views.adminView(c.institutionId, c.year, "room", param(r, "id"))));
router.get("/views/subject/:id", ...READ, h((r, c) => views.adminView(c.institutionId, c.year, "subject", param(r, "id"))));

router.get("/export/:kind/:format", ...READ, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = await ctxOf(req);
    const kind = param(req, "kind");
    const format = param(req, "format");
    if (!["class", "teacher", "room", "master"].includes(kind) || !["pdf", "xlsx"].includes(format)) {
      res.status(400).json({ success: false, error: "Unsupported export" });
      return;
    }
    const id = typeof req.query.id === "string" ? req.query.id : undefined;
    const file = await exportTimetable(c.institutionId, c.year, kind as "class" | "teacher" | "room" | "master", format as "pdf" | "xlsx", id);
    audit(c.actor, "TIMETABLE_EXPORTED", `Exported ${kind} timetable (${format})`, { academicYearId: c.year.id, kind, format });
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.send(file.buffer);
  } catch (err) {
    next(err);
  }
});

// ── Date-specific changes & substitutions ──────────────────────────────────────
const range = (r: AuthRequest) => ({
  from: typeof r.query.from === "string" ? r.query.from : undefined,
  to: typeof r.query.to === "string" ? r.query.to : undefined,
});
router.get("/exceptions", ...READ, h((r, c) => changes.listExceptions(c.institutionId, c.year, { ...range(r), divisionId: typeof r.query.divisionId === "string" ? r.query.divisionId : undefined })));
router.post("/exceptions", ...WRITE, h((r, c) => changes.createException(c.institutionId, c.year, S.exceptionSchema.parse(r.body), c.actor), 201));
router.delete("/exceptions/:id", ...WRITE, h(async (r, c) => { await changes.deleteException(c.institutionId, c.year, param(r, "id"), c.actor); return {}; }));

router.get("/substitutions", ...READ, h((r, c) => changes.listSubstitutions(c.institutionId, c.year, range(r))));
router.get("/substitutions/teacher-day", ...READ, h((r, c) => changes.teacherDayEntries(c.institutionId, c.year, String(r.query.teacherId ?? ""), String(r.query.date ?? ""))));
router.get("/substitutions/candidates", ...READ, h((r, c) => changes.substituteCandidates(c.institutionId, c.year, String(r.query.entryId ?? ""), String(r.query.date ?? ""))));
router.post("/substitutions", ...WRITE, h((r, c) => changes.createSubstitution(c.institutionId, c.year, S.substitutionSchema.parse(r.body), c.actor), 201));
router.delete("/substitutions/:id", ...WRITE, h(async (r, c) => { await changes.deleteSubstitution(c.institutionId, c.year, param(r, "id"), c.actor); return {}; }));

export default router;

// ── Teacher & student self-service (read-only, published data only) ────────────
export const teacherTimetableRouter = Router();
const TEACHER = [authMiddleware(["TEACHER"]), institutionAccessMiddleware, academicRoutingMiddleware];
teacherTimetableRouter.get("/me", ...TEACHER, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = S.weekQuery.parse(req.query);
    const u = req.user!;
    const year = await resolveYear(q.academicYearId, u.institutionId!, { role: u.role, userId: u.userId });
    res.json({ success: true, data: await views.teacherWeek(u.institutionId!, year, u.userId, q.date) });
  } catch (err) { next(err); }
});

// A teacher may read the published timetable of a class they are assigned to in that year (any other class → 403).
teacherTimetableRouter.get("/division/:divisionId", ...TEACHER, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = S.weekQuery.parse(req.query);
    const u = req.user!;
    const divisionId = req.params.divisionId as string;
    const year = await resolveYear(q.academicYearId, u.institutionId!, { role: u.role, userId: u.userId });
    await assertAcademicYearAccess({ role: u.role, userId: u.userId, institutionId: u.institutionId!, academicYearId: year.id, divisionId });
    res.json({ success: true, data: await views.divisionWeek(u.institutionId!, year, divisionId, q.date) });
  } catch (err) { next(err); }
});

export const studentTimetableRouter = Router();
const STUDENT = [authMiddleware(["STUDENT"]), institutionAccessMiddleware, academicRoutingMiddleware];
studentTimetableRouter.get("/me", ...STUDENT, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // Deliberately no divisionId/studentId accepted: the class is derived from the student's own enrollment.
    const q = S.weekQuery.parse(req.query);
    const u = req.user!;
    const year = await resolveYear(q.academicYearId, u.institutionId!, { role: u.role, userId: u.userId });
    res.json({ success: true, data: await views.studentWeek(u.institutionId!, year, u.userId, q.date) });
  } catch (err) { next(err); }
});
