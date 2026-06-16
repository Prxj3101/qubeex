import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
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

const router = Router();

// Base: ADMIN or SUB_ADMIN (role check only)
const A = [authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware];

// ADMIN only — no subadmin access
const ADMIN_ONLY = [authMiddleware(["ADMIN"]), institutionAccessMiddleware];

// SUB_ADMIN needs CAMPUS or FEES permission (read/navigate access)
const FEES_OR_CAMPUS = [...A, requirePermission("FEES", "CAMPUS")];

// SUB_ADMIN needs CAMPUS permission (write/management access)
const CAMPUS_PERM = [...A, requirePermission("CAMPUS")];

// Standards — list is needed for navigation (FEES subadmin needs to see classes)
router.get("/standards", ...FEES_OR_CAMPUS, listStandards);
router.post("/standards", ...ADMIN_ONLY, createStandard);
router.patch("/standards/:id", ...ADMIN_ONLY, updateStandard);
router.delete("/standards/:id", ...ADMIN_ONLY, deleteStandard);

// Divisions
router.post("/standards/:standardId/divisions", ...ADMIN_ONLY, createDivision);
router.get("/divisions/:divisionId", ...FEES_OR_CAMPUS, getDivision);
router.patch("/divisions/:divisionId", ...ADMIN_ONLY, updateDivision);
router.delete("/divisions/:divisionId", ...ADMIN_ONLY, deleteDivision);

// Subjects
router.post("/standards/:standardId/subjects", ...ADMIN_ONLY, createSubject);
router.patch("/subjects/:subjectId", ...ADMIN_ONLY, updateSubject);
router.delete("/subjects/:subjectId", ...ADMIN_ONLY, deleteSubject);

// Division subject selection
router.post("/divisions/:divisionId/subjects/:subjectId", ...ADMIN_ONLY, selectSubject);
router.delete("/divisions/:divisionId/subjects/:subjectId", ...ADMIN_ONLY, deselectSubject);

// Teacher assignments
router.post("/divisions/:divisionId/assign", ...ADMIN_ONLY, assignTeacher);
router.delete("/assignments/:assignmentId", ...ADMIN_ONLY, removeAssignment);

// Fee structure — accessible to FEES or CAMPUS subadmins
router.get("/divisions/:divisionId/fee-structure", ...FEES_OR_CAMPUS, getFeeStructure);
router.put("/divisions/:divisionId/fee-structure", ...FEES_OR_CAMPUS, saveFeeStructure);

// Campus feed upload — CAMPUS permission required to post
router.post("/feed/upload", ...CAMPUS_PERM, upload.single("file"), uploadFeedAttachment);

// Feed posts — read allowed for FEES/CAMPUS (View tab); write needs CAMPUS
router.get("/feed/posts", ...FEES_OR_CAMPUS, listPosts);
router.post("/feed/posts", ...CAMPUS_PERM, createPost);
router.delete("/feed/posts/:id", ...CAMPUS_PERM, deletePost);

// Calendar events — same split
router.get("/feed/events", ...FEES_OR_CAMPUS, listEvents);
router.get("/feed/events/merged", ...FEES_OR_CAMPUS, listMergedEvents);
router.post("/feed/events", ...CAMPUS_PERM, createEvent);
router.delete("/feed/events/:id", ...CAMPUS_PERM, deleteEvent);

export default router;
