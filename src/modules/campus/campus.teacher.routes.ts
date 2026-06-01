import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { listEvents, createEvent, deleteEvent } from "./campus.feed.controller";

const router = Router();

const T = [authMiddleware(["TEACHER", "ADMIN"]), institutionAccessMiddleware];

// Teacher-accessible calendar events (division-scoped)
router.get("/feed/events", ...T, listEvents);
router.post("/feed/events", ...T, createEvent);
router.delete("/feed/events/:id", ...T, deleteEvent);

export default router;
