import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { requirePermission } from "../../middlewares/requirePermission.middleware";
import {
  upload,
  uploadAttachment,
  listPosts,
  createPost,
  deletePost,
  toggleLike,
  addComment,
  deleteComment,
  listDmThreads,
  getMessages,
  sendMessage,
  unsendMessage,
  markRead,
} from "./staffroom.controller";

const router = Router();

// Base: ADMIN or SUB_ADMIN
const A = [authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware];

// ADMIN only (upload is admin-only; can't allow subadmins to post on behalf of admin)
const ADMIN_ONLY = [authMiddleware(["ADMIN"]), institutionAccessMiddleware];

// SUB_ADMIN needs STAFF_STAFFROOM
const STAFFROOM_PERM = [...A, requirePermission("STAFF_STAFFROOM")];

// Upload — admin only
router.post("/upload", ...ADMIN_ONLY, upload.single("file"), uploadAttachment);

// Feed
router.get("/posts", ...STAFFROOM_PERM, listPosts);
router.post("/posts", ...STAFFROOM_PERM, createPost);
router.delete("/posts/:id", ...STAFFROOM_PERM, deletePost);
router.post("/posts/:id/like", ...STAFFROOM_PERM, toggleLike);
router.post("/posts/:id/comments", ...STAFFROOM_PERM, addComment);
router.delete("/posts/:id/comments/:commentId", ...STAFFROOM_PERM, deleteComment);

// DMs
router.get("/dms", ...STAFFROOM_PERM, listDmThreads);
router.get("/dms/:teacherUserId", ...STAFFROOM_PERM, getMessages);
router.post("/dms/:teacherUserId", ...STAFFROOM_PERM, sendMessage);
router.delete("/dms/:teacherUserId/messages/:messageId", ...STAFFROOM_PERM, unsendMessage);
router.patch("/dms/:teacherUserId/read", ...STAFFROOM_PERM, markRead);

export default router;
