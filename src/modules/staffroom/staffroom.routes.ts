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

const A = [authMiddleware(["ADMIN"]), institutionAccessMiddleware];

// Upload
router.post("/upload", ...A, upload.single("file"), uploadAttachment);

// Feed
router.get("/posts", ...A, listPosts);
router.post("/posts", ...A, createPost);
router.delete("/posts/:id", ...A, deletePost);
router.post("/posts/:id/like", ...A, toggleLike);
router.post("/posts/:id/comments", ...A, addComment);
router.delete("/posts/:id/comments/:commentId", ...A, deleteComment);

// DMs
router.get("/dms", ...A, listDmThreads);
router.get("/dms/:teacherUserId", ...A, getMessages);
router.post("/dms/:teacherUserId", ...A, sendMessage);
router.patch("/dms/:teacherUserId/read", ...A, markRead);

export default router;
