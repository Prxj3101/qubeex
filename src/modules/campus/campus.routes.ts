import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
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
} from "./campus.feed.controller";
import { getFeeStructure, saveFeeStructure } from "./campus.fees.controller";

const router = Router();

const A = [authMiddleware(["ADMIN"]), institutionAccessMiddleware];

// Standards
router.get("/standards", ...A, listStandards);
router.post("/standards", ...A, createStandard);
router.patch("/standards/:id", ...A, updateStandard);
router.delete("/standards/:id", ...A, deleteStandard);

// Divisions (nested under standard)
router.post("/standards/:standardId/divisions", ...A, createDivision);
router.get("/divisions/:divisionId", ...A, getDivision);
router.patch("/divisions/:divisionId", ...A, updateDivision);
router.delete("/divisions/:divisionId", ...A, deleteDivision);

// Subjects (nested under standard — shared across all divisions)
router.post("/standards/:standardId/subjects", ...A, createSubject);
router.patch("/subjects/:subjectId", ...A, updateSubject);
router.delete("/subjects/:subjectId", ...A, deleteSubject);

// Division subject selection
router.post("/divisions/:divisionId/subjects/:subjectId", ...A, selectSubject);
router.delete("/divisions/:divisionId/subjects/:subjectId", ...A, deselectSubject);

// Teacher assignments
router.post("/divisions/:divisionId/assign", ...A, assignTeacher);
router.delete("/assignments/:assignmentId", ...A, removeAssignment);

// Fee structure
router.get("/divisions/:divisionId/fee-structure", ...A, getFeeStructure);
router.put("/divisions/:divisionId/fee-structure", ...A, saveFeeStructure);

// Campus feed upload
router.post("/feed/upload", ...A, upload.single("file"), uploadFeedAttachment);

// Campus feed posts
router.get("/feed/posts", ...A, listPosts);
router.post("/feed/posts", ...A, createPost);
router.delete("/feed/posts/:id", ...A, deletePost);

// Calendar events
router.get("/feed/events", ...A, listEvents);
router.post("/feed/events", ...A, createEvent);
router.delete("/feed/events/:id", ...A, deleteEvent);

export default router;
