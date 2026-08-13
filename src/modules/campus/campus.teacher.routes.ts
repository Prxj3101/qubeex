import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { academicDb } from "../../utils/academicContext";
import { ForbiddenError, NotFoundError } from "../../utils/errors";
import {
  upload,
  uploadFeedAttachment,
  listPosts,
  createPost,
  deletePost,
  listEvents,
  createEvent,
  deleteEvent,
} from "./campus.feed.controller";
import { getFeeStructure } from "./campus.fees.controller";
import { getDivisionFeePayments } from "./campus.students.controller";

const router = Router();

const T = [authMiddleware(["TEACHER", "ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware];

// Fees are only visible to the CLASS teacher of a division (the
// DivisionAssignment row with subjectId === null) — subject teachers only
// get students/tasks/marksheet, never fee data. Admin tokens skip this check
// (they don't have a Teacher row at all).
async function requireClassTeacherAccess(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (req.user!.role === "ADMIN") return next();
    const { userId, institutionId } = req.user!;
    const divisionId = req.params.divisionId as string;

    const teacher = await academicDb().teacher.findFirst({ where: { userId, institutionId: institutionId! } });
    if (!teacher) throw new NotFoundError("Teacher profile not found");

    const classTeacherAssignment = await academicDb().divisionAssignment.findFirst({
      where: { divisionId, teacherId: teacher.id, institutionId: institutionId!, subjectId: null },
      select: { id: true },
    });
    if (!classTeacherAssignment) throw new ForbiddenError("Only the class teacher can view fees for this division");

    next();
  } catch (err) {
    next(err);
  }
}

// Feed posts (teacher can post to main feed or class feed)
router.get("/feed/posts", ...T, listPosts);
router.post("/feed/posts", ...T, createPost);
router.delete("/feed/posts/:id", ...T, deletePost);
router.post("/feed/upload", ...T, upload.single("file"), uploadFeedAttachment);

// Calendar events (teacher can only add to class calendar, not main)
router.get("/feed/events", ...T, listEvents);
router.post("/feed/events", ...T, createEvent);
router.delete("/feed/events/:id", ...T, deleteEvent);

// Fees — read-only, class teacher only (reuses the admin controllers directly;
// no separate write routes are exposed here, so a teacher token can never
// edit the fee structure or mark a payment).
router.get("/divisions/:divisionId/fee-structure", ...T, requireClassTeacherAccess, getFeeStructure);
router.get("/divisions/:divisionId/fee-payments", ...T, requireClassTeacherAccess, getDivisionFeePayments);

export default router;
