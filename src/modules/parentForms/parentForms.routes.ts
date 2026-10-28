import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { BadRequestError } from "../../utils/errors";
import {
  createForm, closeForm, remindNonResponders, listFormsForCreator, getFormResults, listTargetDivisions,
  listFormsForStudent, pendingFormCountForStudent, respondToForm, FormActor,
} from "../../services/parentForms.service";
import {
  createSession, cancelSession, releaseSlot, listSessionsForTeacher, listSessionsForAdmin,
  listSessionsForStudent, bookSlot, cancelBooking,
} from "../../services/ptm.service";
import { createFormSchema, respondSchema, createSessionSchema, idParamSchema } from "./parentForms.schema";

function ctx(req: AuthRequest) {
  const { institutionId, userId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return { institutionId, userId };
}

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: AuthRequest, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const STUDENT = [authMiddleware(["STUDENT"]), institutionAccessMiddleware, academicRoutingMiddleware];
const TEACHER = [authMiddleware(["TEACHER"]), institutionAccessMiddleware, academicRoutingMiddleware];
// Admin only: forms and PTM data are scoped to the institution's own admin.
const ADMIN = [authMiddleware(["ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware];

// ── Forms: creator routes (teacher + admin share the same handlers) ──────────

function creatorRoutes(role: "ADMIN" | "TEACHER", guards: typeof TEACHER) {
  const router = Router();
  const actor = (req: AuthRequest): FormActor => ({ ...ctx(req), role });

  router.get("/targets", ...guards, wrap(async (req, res) => {
    res.json({ success: true, data: await listTargetDivisions(actor(req)) });
  }));
  router.get("/", ...guards, wrap(async (req, res) => {
    res.json({ success: true, data: await listFormsForCreator(actor(req)) });
  }));
  router.post("/", ...guards, wrap(async (req, res) => {
    const input = createFormSchema.parse(req.body);
    res.status(201).json({ success: true, data: await createForm(actor(req), input) });
  }));
  router.get("/:id", ...guards, wrap(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    res.json({ success: true, data: await getFormResults(actor(req), id) });
  }));
  router.patch("/:id/close", ...guards, wrap(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    await closeForm(actor(req), id);
    res.json({ success: true });
  }));
  router.post("/:id/remind", ...guards, wrap(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    res.json({ success: true, data: await remindNonResponders(actor(req), id) });
  }));
  return router;
}

export const teacherParentFormsRoutes = creatorRoutes("TEACHER", TEACHER);
export const adminParentFormsRoutes = creatorRoutes("ADMIN", ADMIN);

// ── Forms: parent (student login) ────────────────────────────────────────────

export const studentParentFormsRoutes = Router();

studentParentFormsRoutes.get("/", ...STUDENT, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  res.json({ success: true, data: await listFormsForStudent(userId, institutionId) });
}));

studentParentFormsRoutes.get("/pending-count", ...STUDENT, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  res.json({ success: true, data: { pending: await pendingFormCountForStudent(userId, institutionId) } });
}));

studentParentFormsRoutes.post("/:id/respond", ...STUDENT, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  const input = respondSchema.parse(req.body);
  res.json({ success: true, data: await respondToForm(userId, institutionId, id, input) });
}));

// ── PTM scheduler ────────────────────────────────────────────────────────────

export const teacherPtmRoutes = Router();

teacherPtmRoutes.get("/sessions", ...TEACHER, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  res.json({ success: true, data: await listSessionsForTeacher(userId, institutionId) });
}));

teacherPtmRoutes.post("/sessions", ...TEACHER, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const input = createSessionSchema.parse(req.body);
  res.status(201).json({ success: true, data: await createSession(userId, institutionId, input) });
}));

teacherPtmRoutes.delete("/sessions/:id", ...TEACHER, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  await cancelSession(userId, institutionId, id);
  res.json({ success: true });
}));

teacherPtmRoutes.patch("/slots/:id/release", ...TEACHER, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  await releaseSlot(userId, institutionId, id);
  res.json({ success: true });
}));

export const adminPtmRoutes = Router();

adminPtmRoutes.get("/sessions", ...ADMIN, wrap(async (req, res) => {
  const { institutionId } = ctx(req);
  res.json({ success: true, data: await listSessionsForAdmin(institutionId) });
}));

export const studentPtmRoutes = Router();

studentPtmRoutes.get("/sessions", ...STUDENT, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  res.json({ success: true, data: await listSessionsForStudent(userId, institutionId) });
}));

studentPtmRoutes.post("/slots/:id/book", ...STUDENT, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  res.status(201).json({ success: true, data: await bookSlot(userId, institutionId, id) });
}));

studentPtmRoutes.delete("/slots/:id/book", ...STUDENT, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  await cancelBooking(userId, institutionId, id);
  res.json({ success: true });
}));
