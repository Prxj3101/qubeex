import { Router } from "express";
import { verifyInvite, acceptInvite, login, logout } from "./auth.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { authLimiter } from "../../middlewares/rateLimiter.middleware";

const router = Router();

router.get("/invite/verify", verifyInvite);
router.post("/invite/accept", authLimiter, acceptInvite);
router.post("/login", authLimiter, login);
router.post("/logout", authMiddleware(), logout);

export default router;