import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
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

const T = [authMiddleware(["TEACHER"]), institutionAccessMiddleware, academicRoutingMiddleware];

// Upload — multer runs before academicRoutingMiddleware (not via `...T`): busboy's
// internal stream events aren't reliably tracked as children of the AsyncLocalStorage
// scope academicRoutingMiddleware opens, so parsing the file first avoids the handler
// seeing "No academic client in context".
router.post("/upload", authMiddleware(["TEACHER"]), institutionAccessMiddleware, upload.single("file"), academicRoutingMiddleware, uploadAttachment);

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
router.delete("/dms/:teacherUserId/messages/:messageId", ...T, unsendMessage);
router.patch("/dms/:teacherUserId/read", ...T, markRead);

export default router;
