import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { requirePermission } from "../../middlewares/requirePermission.middleware";
import {
  listStandards,
  createStandard,
  updateStandard,
  deleteStandard,
  createDivision,
  updateDivision,
  deleteDivision,
  getDivision,
  createSubject,
  updateSubject,
  deleteSubject,
  reorderSubjects,
  selectSubject,
  deselectSubject,
  assignTeacher,
  removeAssignment,
} from "./campus.controller";
import {
  upload,
  uploadFeedAttachment,
  listPosts,
  createPost,
  deletePost,
  listEvents,
  createEvent,
  deleteEvent,
  listMergedEvents,
} from "./campus.feed.controller";
import { getFeeStructure, saveFeeStructure } from "./campus.fees.controller";
import {
  getDivisionStudents,
  getAttendanceHolidays,
  getDailyAttendance,
  getMonthlyAttendance,
  getAttendanceSummary,
  getStudentAttendanceRecords,
} from "./campus.attendance.controller";
import {
  getStudentStats,
  updateStudentStatus,
  getDivisionLeaderboard,
  reportStudent,
  getStudentRemarks,
  getReportsInbox,
  reviewReport,
  deleteReport,
  getStudentMarksheet,
  getStudentAttendanceTrend,
  getStudentAttendanceDetail,
  editReport,
  getDivisionFeePayments,
  updateFeePayment,
  updateStudentDetailField,
} from "./campus.students.controller";

const router = Router();

// Base: ADMIN or SUB_ADMIN (role check only)
const A = [authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware];

// ADMIN only
const ADMIN_ONLY = [authMiddleware(["ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware];

// Any CAMPUS_* permission allows navigating to the campus section
const ANY_CAMPUS = [...A, requirePermission("CAMPUS_FEED", "CAMPUS_VIEW", "CAMPUS_MANAGE", "CAMPUS_FEES", "CAMPUS_ATTENDANCE", "CAMPUS_MARKSHEET")];

// Feed tab — read requires CAMPUS_FEED; write requires CAMPUS_FEED (admin can always write)
const CAMPUS_FEED_READ = [...A, requirePermission("CAMPUS_FEED")];

// View tab in classes
const CAMPUS_VIEW_PERM = [...A, requirePermission("CAMPUS_VIEW")];

// Division core data — needed by every class tab, not just View, so any
// class-tab permission should unlock it.
const ANY_CLASS_TAB_PERM = [...A, requirePermission("CAMPUS_VIEW", "CAMPUS_MANAGE", "CAMPUS_FEES", "CAMPUS_ATTENDANCE", "CAMPUS_MARKSHEET")];

// Manage permission to write/modify class content
const CAMPUS_MANAGE_PERM = [...A, requirePermission("CAMPUS_MANAGE")];

// Fees
const CAMPUS_FEES_PERM = [...A, requirePermission("CAMPUS_FEES")];

// Standards — list is needed for any classes tab
router.get("/standards", ...ANY_CAMPUS, listStandards);
router.post("/standards", ...CAMPUS_MANAGE_PERM, createStandard);
router.patch("/standards/:id", ...CAMPUS_MANAGE_PERM, updateStandard);
router.delete("/standards/:id", ...CAMPUS_MANAGE_PERM, deleteStandard);

// Divisions
router.post("/standards/:standardId/divisions", ...CAMPUS_MANAGE_PERM, createDivision);
router.get("/divisions/:divisionId", ...ANY_CLASS_TAB_PERM, getDivision);
router.patch("/divisions/:divisionId", ...CAMPUS_MANAGE_PERM, updateDivision);
router.delete("/divisions/:divisionId", ...CAMPUS_MANAGE_PERM, deleteDivision);

// Subjects
router.post("/standards/:standardId/subjects", ...CAMPUS_MANAGE_PERM, createSubject);
router.patch("/standards/:standardId/subjects/reorder", ...CAMPUS_MANAGE_PERM, reorderSubjects);
router.patch("/subjects/:subjectId", ...CAMPUS_MANAGE_PERM, updateSubject);
router.delete("/subjects/:subjectId", ...CAMPUS_MANAGE_PERM, deleteSubject);

// Division subject selection — CAMPUS_MANAGE
router.post("/divisions/:divisionId/subjects/:subjectId", ...CAMPUS_MANAGE_PERM, selectSubject);
router.delete("/divisions/:divisionId/subjects/:subjectId", ...CAMPUS_MANAGE_PERM, deselectSubject);

// Teacher assignments — CAMPUS_MANAGE
router.post("/divisions/:divisionId/assign", ...CAMPUS_MANAGE_PERM, assignTeacher);
router.delete("/assignments/:assignmentId", ...CAMPUS_MANAGE_PERM, removeAssignment);

// Fee structure — CAMPUS_FEES or CAMPUS_MANAGE
router.get("/divisions/:divisionId/fee-structure", ...CAMPUS_FEES_PERM, getFeeStructure);
router.put("/divisions/:divisionId/fee-structure", ...CAMPUS_FEES_PERM, saveFeeStructure);
router.get("/divisions/:divisionId/fee-payments", ...CAMPUS_FEES_PERM, getDivisionFeePayments);
router.patch("/divisions/:divisionId/fee-payments", ...CAMPUS_FEES_PERM, updateFeePayment);
router.patch("/divisions/:divisionId/students/:studentId/detail-fields", ...CAMPUS_FEES_PERM, updateStudentDetailField);

// Feed upload — campus feed OR class overview (VIEW). multer runs before
// academicRoutingMiddleware (not via `...FEED_WRITE`): busboy's internal stream
// events aren't reliably tracked as children of the AsyncLocalStorage scope
// academicRoutingMiddleware opens, so parsing the file first avoids the handler
// seeing "No academic client in context".
const FEED_WRITE = [...A, requirePermission("CAMPUS_FEED", "CAMPUS_VIEW")];
router.post("/feed/upload", authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware, requirePermission("CAMPUS_FEED", "CAMPUS_VIEW"), upload.single("file"), academicRoutingMiddleware, uploadFeedAttachment);

// Feed posts — campus feed OR class overview (VIEW/MANAGE can read class posts)
const FEED_READ = [...A, requirePermission("CAMPUS_FEED", "CAMPUS_VIEW", "CAMPUS_MANAGE")];
router.get("/feed/posts", ...FEED_READ, listPosts);
router.post("/feed/posts", ...FEED_WRITE, createPost);
router.delete("/feed/posts/:id", ...FEED_WRITE, deletePost);

// Attendance — strict: CAMPUS_ATTENDANCE only
const ATTENDANCE_PERM = [...A, requirePermission("CAMPUS_ATTENDANCE")];
router.get("/divisions/:divisionId/students", ...A, requirePermission("CAMPUS_ATTENDANCE", "CAMPUS_MANAGE", "CAMPUS_FEES"), getDivisionStudents);
router.get("/divisions/:divisionId/students/:studentId/stats", ...CAMPUS_MANAGE_PERM, getStudentStats);
router.patch("/divisions/:divisionId/students/:studentId", ...CAMPUS_MANAGE_PERM, updateStudentStatus);
router.post("/divisions/:divisionId/students/:studentId/remarks", ...CAMPUS_MANAGE_PERM, reportStudent);
router.get("/divisions/:divisionId/students/:studentId/remarks", ...CAMPUS_MANAGE_PERM, getStudentRemarks);
router.get("/reports/inbox", ...CAMPUS_MANAGE_PERM, getReportsInbox);
router.patch("/reports/:remarkId", ...CAMPUS_MANAGE_PERM, reviewReport);
router.patch("/reports/:remarkId/edit", ...CAMPUS_MANAGE_PERM, editReport);
router.delete("/reports/:remarkId", ...CAMPUS_MANAGE_PERM, deleteReport);
router.get("/divisions/:divisionId/students/:studentId/marksheet", ...CAMPUS_MANAGE_PERM, getStudentMarksheet);
router.get("/divisions/:divisionId/students/:studentId/attendance-trend", ...CAMPUS_MANAGE_PERM, getStudentAttendanceTrend);
router.get("/divisions/:divisionId/students/:studentId/attendance", ...CAMPUS_MANAGE_PERM, getStudentAttendanceDetail);
router.get("/divisions/:divisionId/leaderboard", ...A, requirePermission("CAMPUS_VIEW", "CAMPUS_MANAGE"), getDivisionLeaderboard);
router.get("/divisions/:divisionId/attendance/holidays", ...ATTENDANCE_PERM, getAttendanceHolidays);
router.get("/divisions/:divisionId/attendance/daily", ...ATTENDANCE_PERM, getDailyAttendance);
router.get("/divisions/:divisionId/attendance/monthly", ...ATTENDANCE_PERM, getMonthlyAttendance);
router.get("/divisions/:divisionId/attendance/summary", ...ATTENDANCE_PERM, getAttendanceSummary);
router.get("/divisions/:divisionId/attendance/student-records/:studentId", ...ATTENDANCE_PERM, getStudentAttendanceRecords);

// Calendar events — readable from any campus tab; write via CAMPUS_FEED or CAMPUS_VIEW (class calendar)
router.get("/feed/events", ...ANY_CAMPUS, listEvents);
router.get("/feed/events/merged", ...ANY_CAMPUS, listMergedEvents);
router.post("/feed/events", ...FEED_WRITE, createEvent);
router.delete("/feed/events/:id", ...FEED_WRITE, deleteEvent);

export default router;
