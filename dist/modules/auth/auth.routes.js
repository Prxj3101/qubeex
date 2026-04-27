"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("./auth.controller");
const auth_middleware_1 = require("../../middlewares/auth.middleware");
const rateLimiter_middleware_1 = require("../../middlewares/rateLimiter.middleware");
const router = (0, express_1.Router)();
// ── Invite flow ──────────────────────────────────────────────────────────────
router.get("/invite/verify", auth_controller_1.verifyInvite); // legacy route
router.get("/verify-invite", auth_controller_1.verifyInvite); // frontend: /auth/verify-invite?token=
router.post("/invite/accept", rateLimiter_middleware_1.authLimiter, auth_controller_1.acceptInvite); // legacy route
router.post("/set-password", rateLimiter_middleware_1.authLimiter, auth_controller_1.acceptInvite); // frontend: /auth/set-password
// ── Auth ─────────────────────────────────────────────────────────────────────
router.post("/login", rateLimiter_middleware_1.authLimiter, auth_controller_1.login);
router.post("/logout", (0, auth_middleware_1.authMiddleware)(), auth_controller_1.logout);
exports.default = router;
