import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { requirePermission } from "../../middlewares/requirePermission.middleware";
import { resolveRequestedAcademicYear } from "../../utils/academicYear";
import * as fees from "./fees.service";

// Fees desk (Admin > Fees). Anyone with the class fees permission (e.g. the
// school accountant) can collect; only the admin can cancel a receipt.
const router = Router();

const FEES = [authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware, requirePermission("CAMPUS_FEES")];
const ADMIN_ONLY = [authMiddleware(["ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware];

const yearQuery = z.object({ academicYearId: z.string().uuid().optional() }).passthrough();

async function ctxOf(req: AuthRequest) {
  const u = req.user!;
  if (!u.institutionId) throw { status: 400, message: "No institution" };
  const { academicYearId } = yearQuery.parse(req.query);
  const year = await resolveRequestedAcademicYear(academicYearId, u.institutionId, { role: u.role, userId: u.userId });
  return { institutionId: u.institutionId, year, actor: { userId: u.userId, role: u.role, institutionId: u.institutionId, ip: req.ip } };
}
type Ctx = Awaited<ReturnType<typeof ctxOf>>;

const h = (fn: (req: AuthRequest, c: Ctx) => Promise<unknown>, status = 200) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ success: true, data: await fn(req, await ctxOf(req)) });
    } catch (err) {
      next(err);
    }
  };

const dayQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).passthrough();
const duesQuery = z.object({ divisionId: z.string().uuid().optional(), month: z.string().max(20).optional() }).passthrough();

router.get("/students/search", ...FEES, h((req, c) => fees.searchStudents(c.institutionId, c.year, String(req.query.q ?? "").slice(0, 80))));
router.get("/students/:studentId", ...FEES, h((req, c) => fees.studentAccount(c.institutionId, c.year, String(req.params.studentId))));
router.post("/receipts", ...FEES, h((req, c) => fees.collect(c.institutionId, c.year, fees.collectSchema.parse(req.body), c.actor), 201));
router.get("/receipts/:id", ...FEES, h((req, c) => fees.getReceipt(c.institutionId, String(req.params.id))));
router.post("/receipts/:id/cancel", ...ADMIN_ONLY, h((req, c) => fees.cancelReceipt(c.institutionId, String(req.params.id), fees.cancelSchema.parse(req.body).reason, c.actor)));
router.get("/day-book", ...FEES, h((req, c) => fees.dayBook(c.institutionId, dayQuery.parse(req.query).date ?? fees.istToday())));
router.get("/dues", ...FEES, h((req, c) => fees.dues(c.institutionId, c.year, duesQuery.parse(req.query))));
router.get("/setup/status", ...FEES, h((_req, c) => fees.setupStatus(c.institutionId, c.year)));
router.post("/setup/copy", ...FEES, h((req, c) => fees.copySetup(c.institutionId, c.year, fees.copySetupSchema.parse(req.body), c.actor)));
router.post("/reminders", ...FEES, h((req, c) => fees.logReminder(c.institutionId, c.year, fees.reminderSchema.parse(req.body), c.actor), 201));

export default router;
