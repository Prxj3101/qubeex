import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
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
  markRead,
} from "./staffroom.controller";

const router = Router();

const T = [authMiddleware(["TEACHER"]), institutionAccessMiddleware];

// Upload
router.post("/upload", ...T, upload.single("file"), uploadAttachment);

// Feed
router.get("/posts", ...T, listPosts);
router.post("/posts", ...T, createPost);
router.delete("/posts/:id", ...T, deletePost);
router.post("/posts/:id/like", ...T, toggleLike);
router.post("/posts/:id/comments", ...T, addComment);
router.delete("/posts/:id/comments/:commentId", ...T, deleteComment);

// DMs
router.get("/dms", ...T, listDmThreads);
router.get("/dms/:teacherUserId", ...T, getMessages);
router.post("/dms/:teacherUserId", ...T, sendMessage);
router.patch("/dms/:teacherUserId/read", ...T, markRead);

export default router;
