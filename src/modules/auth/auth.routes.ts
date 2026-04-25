import { Router } from "express";
import { verifyInvite, acceptInvite, login, logout } from "./auth.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { authLimiter } from "../../middlewares/rateLimiter.middleware";

const router = Router();

// ── Invite flow ──────────────────────────────────────────────────────────────
router.get("/invite/verify", verifyInvite);      // legacy route
router.get("/verify-invite", verifyInvite);      // frontend: /auth/verify-invite?token=

router.post("/invite/accept", authLimiter, acceptInvite);   // legacy route
router.post("/set-password", authLimiter, acceptInvite);    // frontend: /auth/set-password

// ── Auth ─────────────────────────────────────────────────────────────────────
router.post("/login", authLimiter, login);
router.post("/logout", authMiddleware(), logout);

export default router;