import { Router, raw, Response } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { setPresence } from "../../services/presence.service";
import { getMyInstitution, updateMyInstitution, uploadMyInstitutionLogo, listTeachers, addTeacher, getTeacher, updateTeacher, getInstitutionStructure, uploadTeacherAvatar, listStudents, addStudent, getStudent, updateStudent, resendTeacherInvite } from "./admin.controller";
import { listTickets, createTicket, addTicketReply, listReviews, createReview, updateReview } from "./support.controller";
import { listAuditLogs } from "./audit.controller";
import { listNotifications, markNotificationRead, dismissNotification, markAllNotificationsRead } from "./notifications.controller";
import { getOverview } from "./overview.controller";

const router = Router();

const A = [authMiddleware(["ADMIN"]), institutionAccessMiddleware];

router.post("/presence", ...A, async (req: AuthRequest, res: Response) => {
  await setPresence(req.user!.userId);
  res.json({ success: true });
});

router.get("/me", ...A, getMyInstitution);
router.get("/overview", ...A, getOverview);
router.patch("/institution", ...A, updateMyInstitution);
router.post(
  "/institution/logo",
  ...A,
  raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }),
  uploadMyInstitutionLogo
);

router.get("/teachers", ...A, listTeachers);
router.post("/teachers", ...A, addTeacher);
router.get("/teachers/:id", ...A, getTeacher);
router.patch("/teachers/:id", ...A, updateTeacher);
router.post(
  "/teachers/:id/avatar",
  ...A,
  raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }),
  uploadTeacherAvatar
);
router.post("/teachers/:id/resend-invite", ...A, resendTeacherInvite);
router.get("/students", ...A, listStudents);
router.post("/students", ...A, addStudent);
router.get("/students/:id", ...A, getStudent);
router.patch("/students/:id", ...A, updateStudent);

// Institution structure (for teacher assignment UI)
router.get("/structure", ...A, getInstitutionStructure);

// Support tickets
router.get("/support/tickets", ...A, listTickets);
router.post("/support/tickets", ...A, createTicket);
router.post("/support/tickets/:ticketId/replies", ...A, addTicketReply);

// Reviews
router.get("/support/reviews", ...A, listReviews);
router.post("/support/reviews", ...A, createReview);
router.patch("/support/reviews/:id", ...A, updateReview);

// Audit logs
router.get("/audit-logs", ...A, listAuditLogs);

// Notifications
router.get("/notifications", ...A, listNotifications);
router.patch("/notifications/read-all", ...A, markAllNotificationsRead);
router.patch("/notifications/:recipientId/read", ...A, markNotificationRead);
router.patch("/notifications/:recipientId/dismiss", ...A, dismissNotification);

export default router;
