import { Router, raw, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { requirePermission } from "../../middlewares/requirePermission.middleware";
import { prisma } from "../../utils/prisma";
import { setPresence } from "../../services/presence.service";
import { generateSignedAvatarUrl } from "../../services/storage.service";
import { getMyInstitution, updateMyInstitution, updateAdminMe, uploadAdminPhoto, uploadMyInstitutionLogo, listTeachers, addTeacher, getTeacher, updateTeacher, updateTeacherAiSoftLimit, getInstitutionStructure, uploadTeacherAvatar, listStudents, searchStudents, addStudent, getStudent, updateStudent, resendTeacherInvite, deleteTeacher, listSubAdmins, addSubAdmin, updateSubAdmin, updateSubAdminMe, uploadSubAdminPhoto, updateSubAdminPermissions, deactivateSubAdmin, activateSubAdmin, resendSubAdminInvite, deleteSubAdmin } from "./admin.controller";
import { listTickets, createTicket, addTicketReply, listReviews, createReview, updateReview, uploadTicketAttachment, ticketAttachmentUpload } from "./support.controller";
import { listAuditLogs } from "./audit.controller";
import { listNotifications, markNotificationRead, dismissNotification, markAllNotificationsRead } from "./notifications.controller";
import { getOverview } from "./overview.controller";
import {
  getNotepad,
  createNote,
  updateNote,
  deleteNote,
  createTask,
  updateTask,
  deleteTask,
} from "./notepad.controller";
import { adminListMarksheets, adminGetDivisionMarksheet, adminGetDivisionOnlineMarksheet, assignClassTeacher } from "./marksheet.controller";
import { listBills, getPaymentLink, getPlanHistory, getPaymentSettings } from "./bills.controller";
import { getAttendanceInsights, getFeeInsights, getFeeAiInsights, getAiUsageInsights, getUsersInsights, getTeacherAiUsage, getParentEngagementInsights } from "./insights.controller";
import {
  getProfile as sharedGetProfile,
  updateProfile as sharedUpdateProfile,
  changePassword as sharedChangePassword,
  getLoginActivity as sharedGetLoginActivity,
} from "../shared/profile.controller";

const router = Router();

// ADMIN or SUB_ADMIN — shared base
const A = [authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware];

// ADMIN only
const ADMIN_ONLY = [authMiddleware(["ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware];

// SUB_ADMIN needs STAFF_TEACHERS to view teacher list/detail
const TEACHERS_READ = [...A, requirePermission("STAFF_TEACHERS")];

// SUB_ADMIN needs SUPPORT permission
const SUPPORT_PERM = [...A, requirePermission("SUPPORT")];

// SUB_ADMIN needs AUDIT_LOGS permission
const AUDIT_PERM = [...A, requirePermission("AUDIT_LOGS")];

// SUB_ADMIN needs STAFF_SUBADMINS to view subadmin list
const SUBADMINS_READ = [...A, requirePermission("STAFF_SUBADMINS")];

// SUB_ADMIN needs INSIGHTS_SUBSCRIPTION to view billing/plan info
const INSIGHTS_SUBSCRIPTION_PERM = [...A, requirePermission("INSIGHTS_SUBSCRIPTION")];

// SUB_ADMIN needs CAMPUS_MARKSHEET to view class marksheets
const MARKSHEET_PERM = [...A, requirePermission("CAMPUS_MARKSHEET")];

// SUB_ADMIN needs INSIGHTS_ANALYTICS to view the analytics breakdowns
const INSIGHTS_ANALYTICS_PERM = [...A, requirePermission("INSIGHTS_ANALYTICS")];

router.post("/presence", ...A, async (req: AuthRequest, res: Response) => {
  await setPresence(req.user!.userId);
  res.json({ success: true });
});

router.get("/me", ...A, getMyInstitution);
router.patch("/me", ...ADMIN_ONLY, updateAdminMe);

// ── Account settings (profile / password / login activity) — admin & sub-admin ─
router.get("/profile", ...A, sharedGetProfile);
router.put("/profile", ...A, sharedUpdateProfile);
router.put("/profile/password", ...A, sharedChangePassword);
router.get("/profile/login-activity", ...A, sharedGetLoginActivity);
router.post(
  "/me/photo",
  ...ADMIN_ONLY,
  raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "5mb" }),
  uploadAdminPhoto
);
router.get("/subadmin/me", ...A, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== "SUB_ADMIN") {
      return res.json({ success: true, data: { permissions: null } });
    }
    const subAdmin = await prisma.subAdmin.findFirst({
      where: { userId: req.user!.userId },
      include: { user: { omit: { password: true } } },
    });
    if (!subAdmin) {
      res.status(404).json({ success: false, error: "SubAdmin profile not found" });
      return;
    }
    const avatarUrl = subAdmin.avatarUrl ? (await generateSignedAvatarUrl(subAdmin.avatarUrl)) ?? subAdmin.avatarUrl : null;
    res.json({
      success: true,
      data: {
        id: subAdmin.id,
        name: subAdmin.user.name,
        email: subAdmin.user.email,
        displayId: subAdmin.user.displayId,
        avatarUrl,
        prefix: subAdmin.prefix,
        designation: subAdmin.designation,
        phone: subAdmin.phone,
        dob: subAdmin.dob,
        gender: subAdmin.gender,
        address: subAdmin.address,
        city: subAdmin.city,
        state: subAdmin.state,
        pincode: subAdmin.pincode,
        country: subAdmin.country,
        qualification: subAdmin.qualification,
        experience: subAdmin.experience,
        createdAt: subAdmin.createdAt,
        isActive: subAdmin.user.isActive,
        permissions: subAdmin.permissions,
      },
    });
  } catch (err) {
    next(err);
  }
});
router.patch("/subadmin/me", ...A, updateSubAdminMe);
router.post(
  "/subadmin/me/photo",
  ...A,
  raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "5mb" }),
  uploadSubAdminPhoto
);
router.get("/overview", ...A, getOverview);

// ── Notepad ───────────────────────────────────────────────────────────────────
router.get("/notepad", ...A, getNotepad);
router.post("/notepad/notes", ...A, createNote);
router.patch("/notepad/notes/:id", ...A, updateNote);
router.delete("/notepad/notes/:id", ...A, deleteNote);
router.post("/notepad/tasks", ...A, createTask);
router.patch("/notepad/tasks/:id", ...A, updateTask);
router.delete("/notepad/tasks/:id", ...A, deleteTask);
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
router.patch("/teachers/:id/ai-soft-limit", ...ADMIN_ONLY, updateTeacherAiSoftLimit);
router.get("/teachers/:id/ai-usage", ...TEACHERS_READ, getTeacherAiUsage);
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
router.patch("/subadmins/:id", ...ADMIN_ONLY, updateSubAdmin);
router.patch("/subadmins/:id/permissions", ...ADMIN_ONLY, updateSubAdminPermissions);
router.patch("/subadmins/:id/deactivate", ...ADMIN_ONLY, deactivateSubAdmin);
router.patch("/subadmins/:id/activate", ...ADMIN_ONLY, activateSubAdmin);
router.post("/subadmins/:id/resend-invite", ...ADMIN_ONLY, resendSubAdminInvite);
router.delete("/subadmins/:id", ...ADMIN_ONLY, deleteSubAdmin);

// Students — ADMIN only
router.get("/students", ...ADMIN_ONLY, listStudents);
router.get("/students/search", ...ADMIN_ONLY, searchStudents);
router.post("/students", ...ADMIN_ONLY, addStudent);
router.get("/students/:id", ...ADMIN_ONLY, getStudent);
router.patch("/students/:id", ...ADMIN_ONLY, updateStudent);

// Institution structure (for teacher assignment UI)
router.get("/structure", ...A, getInstitutionStructure);

// Support — SUPPORT permission
router.get("/support/tickets", ...SUPPORT_PERM, listTickets);
router.post("/support/tickets", ...SUPPORT_PERM, createTicket);
router.post("/support/tickets/:ticketId/replies", ...SUPPORT_PERM, addTicketReply);
// multer runs before academicRoutingMiddleware (not via `...SUPPORT_PERM`): busboy's
// internal stream events aren't reliably tracked as children of the AsyncLocalStorage
// scope academicRoutingMiddleware opens, so parsing the file first avoids the handler
// seeing "No academic client in context".
router.post("/support/tickets/attachments", authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware, requirePermission("SUPPORT"), ticketAttachmentUpload.single("file"), academicRoutingMiddleware, uploadTicketAttachment);
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
router.get("/marksheet", ...MARKSHEET_PERM, adminListMarksheets);
router.get("/marksheet/division/:divisionId", ...MARKSHEET_PERM, adminGetDivisionMarksheet);
router.get("/marksheet/division/:divisionId/online", ...MARKSHEET_PERM, adminGetDivisionOnlineMarksheet);

// ── Class teacher assignment ──────────────────────────────────────────────────
router.patch("/campus/divisions/:divisionId/class-teacher", ...ADMIN_ONLY, assignClassTeacher);

// ── Bills ─────────────────────────────────────────────────────────────────────
router.get("/bills", ...INSIGHTS_SUBSCRIPTION_PERM, listBills);
router.get("/bills/:id/payment-link", ...INSIGHTS_SUBSCRIPTION_PERM, getPaymentLink);
router.get("/plan-history", ...INSIGHTS_SUBSCRIPTION_PERM, getPlanHistory);
router.get("/payment-settings", ...INSIGHTS_SUBSCRIPTION_PERM, getPaymentSettings);

// ── Insights (Analytics tab) ──────────────────────────────────────────────────
router.get("/insights/attendance", ...INSIGHTS_ANALYTICS_PERM, getAttendanceInsights);
router.get("/insights/fees", ...INSIGHTS_ANALYTICS_PERM, getFeeInsights);
router.get("/insights/fees/ai", ...INSIGHTS_ANALYTICS_PERM, getFeeAiInsights);
router.get("/insights/ai-usage", ...INSIGHTS_ANALYTICS_PERM, getAiUsageInsights);
router.get("/insights/parent-engagement", ...INSIGHTS_ANALYTICS_PERM, getParentEngagementInsights);
router.get("/insights/users", ...A, getUsersInsights);

export default router;
