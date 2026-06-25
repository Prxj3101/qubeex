import { Router, raw, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { requirePermission } from "../../middlewares/requirePermission.middleware";
import { prisma } from "../../utils/prisma";
import { setPresence } from "../../services/presence.service";
import { getMyInstitution, updateMyInstitution, uploadMyInstitutionLogo, listTeachers, addTeacher, getTeacher, updateTeacher, getInstitutionStructure, uploadTeacherAvatar, listStudents, addStudent, getStudent, updateStudent, resendTeacherInvite, deleteTeacher, listSubAdmins, addSubAdmin, updateSubAdminPermissions, deactivateSubAdmin, resendSubAdminInvite, deleteSubAdmin } from "./admin.controller";
import { listTickets, createTicket, addTicketReply, listReviews, createReview, updateReview } from "./support.controller";
import { listAuditLogs } from "./audit.controller";
import { listNotifications, markNotificationRead, dismissNotification, markAllNotificationsRead } from "./notifications.controller";
import { getOverview } from "./overview.controller";
import { adminListMarksheets, adminGetDivisionMarksheet, assignClassTeacher } from "./marksheet.controller";
import { listBills, getPaymentLink } from "./bills.controller";

const router = Router();

// ADMIN or SUB_ADMIN — shared base
const A = [authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware];

// ADMIN only
const ADMIN_ONLY = [authMiddleware(["ADMIN"]), institutionAccessMiddleware];

// SUB_ADMIN needs STAFF_TEACHERS to view teacher list/detail
const TEACHERS_READ = [...A, requirePermission("STAFF_TEACHERS")];

// SUB_ADMIN needs SUPPORT permission
const SUPPORT_PERM = [...A, requirePermission("SUPPORT")];

// SUB_ADMIN needs AUDIT_LOGS permission
const AUDIT_PERM = [...A, requirePermission("AUDIT_LOGS")];

// SUB_ADMIN needs STAFF_SUBADMINS to view subadmin list
const SUBADMINS_READ = [...A, requirePermission("STAFF_SUBADMINS")];

router.post("/presence", ...A, async (req: AuthRequest, res: Response) => {
  await setPresence(req.user!.userId);
  res.json({ success: true });
});

router.get("/me", ...A, getMyInstitution);
router.get("/subadmin/me", ...A, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== "SUB_ADMIN") {
      return res.json({ success: true, data: { permissions: null } });
    }
    const subAdmin = await prisma.subAdmin.findFirst({
      where: { userId: req.user!.userId },
      select: { permissions: true },
    });
    res.json({ success: true, data: { permissions: subAdmin?.permissions ?? [] } });
  } catch (err) {
    next(err);
  }
});
router.get("/overview", ...A, getOverview);
router.patch("/institution", ...ADMIN_ONLY, updateMyInstitution);
router.post(
  "/institution/logo",
  ...ADMIN_ONLY,
  raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }),
  uploadMyInstitutionLogo
);

// Teachers — read allowed for STAFF_TEACHERS; write is ADMIN only
router.get("/teachers", ...TEACHERS_READ, listTeachers);
router.post("/teachers", ...ADMIN_ONLY, addTeacher);
router.get("/teachers/:id", ...TEACHERS_READ, getTeacher);
router.patch("/teachers/:id", ...ADMIN_ONLY, updateTeacher);
router.post(
  "/teachers/:id/avatar",
  ...ADMIN_ONLY,
  raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }),
  uploadTeacherAvatar
);
router.post("/teachers/:id/resend-invite", ...ADMIN_ONLY, resendTeacherInvite);
router.delete("/teachers/:id", ...ADMIN_ONLY, deleteTeacher);

// Subadmin management — ADMIN only for CRUD; SUB_ADMIN with STAFF_SUBADMINS can list
router.get("/subadmins", ...SUBADMINS_READ, listSubAdmins);
router.post("/subadmins", ...ADMIN_ONLY, addSubAdmin);
router.patch("/subadmins/:id/permissions", ...ADMIN_ONLY, updateSubAdminPermissions);
router.patch("/subadmins/:id/deactivate", ...ADMIN_ONLY, deactivateSubAdmin);
router.post("/subadmins/:id/resend-invite", ...ADMIN_ONLY, resendSubAdminInvite);
router.delete("/subadmins/:id", ...ADMIN_ONLY, deleteSubAdmin);

// Students — ADMIN only
router.get("/students", ...ADMIN_ONLY, listStudents);
router.post("/students", ...ADMIN_ONLY, addStudent);
router.get("/students/:id", ...ADMIN_ONLY, getStudent);
router.patch("/students/:id", ...ADMIN_ONLY, updateStudent);

// Institution structure (for teacher assignment UI)
router.get("/structure", ...A, getInstitutionStructure);

// Support — SUPPORT permission
router.get("/support/tickets", ...SUPPORT_PERM, listTickets);
router.post("/support/tickets", ...SUPPORT_PERM, createTicket);
router.post("/support/tickets/:ticketId/replies", ...SUPPORT_PERM, addTicketReply);
router.get("/support/reviews", ...SUPPORT_PERM, listReviews);
router.post("/support/reviews", ...SUPPORT_PERM, createReview);
router.patch("/support/reviews/:id", ...SUPPORT_PERM, updateReview);

// Audit logs — AUDIT_LOGS permission
router.get("/audit-logs", ...AUDIT_PERM, listAuditLogs);

// Notifications — always accessible to any logged-in ADMIN/SUB_ADMIN
router.get("/notifications", ...A, listNotifications);
router.patch("/notifications/read-all", ...A, markAllNotificationsRead);
router.patch("/notifications/:recipientId/read", ...A, markNotificationRead);
router.patch("/notifications/:recipientId/dismiss", ...A, dismissNotification);

// ── Marksheet (admin read-only) ───────────────────────────────────────────────
router.get("/marksheet", ...A, adminListMarksheets);
router.get("/marksheet/division/:divisionId", ...A, adminGetDivisionMarksheet);

// ── Class teacher assignment ──────────────────────────────────────────────────
router.patch("/campus/divisions/:divisionId/class-teacher", ...ADMIN_ONLY, assignClassTeacher);

// ── Bills ─────────────────────────────────────────────────────────────────────
router.get("/bills", ...ADMIN_ONLY, listBills);
router.get("/bills/:id/payment-link", ...ADMIN_ONLY, getPaymentLink);

export default router;
