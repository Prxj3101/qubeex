import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
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

const router = Router();

const T = [authMiddleware(["TEACHER", "ADMIN"]), institutionAccessMiddleware];

// Feed posts (teacher can post to main feed or class feed)
router.get("/feed/posts", ...T, listPosts);
router.post("/feed/posts", ...T, createPost);
router.delete("/feed/posts/:id", ...T, deletePost);
router.post("/feed/upload", ...T, upload.single("file"), uploadFeedAttachment);

// Calendar events (teacher can only add to class calendar, not main)
router.get("/feed/events", ...T, listEvents);
router.post("/feed/events", ...T, createEvent);
router.delete("/feed/events/:id", ...T, deleteEvent);

export default router;
