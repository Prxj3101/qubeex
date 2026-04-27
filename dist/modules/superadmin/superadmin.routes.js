"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../../middlewares/auth.middleware");
const superadmin_controller_1 = require("./superadmin.controller");
const router = (0, express_1.Router)();
const SA = (0, auth_middleware_1.authMiddleware)(["SUPER_ADMIN"]);
// ─── Profile ─────────────────────────────────────────────────────────────────
router.get("/profile", SA, superadmin_controller_1.getProfile);
router.put("/profile", SA, superadmin_controller_1.updateProfile);
router.put("/profile/password", SA, superadmin_controller_1.changePassword);
router.get("/profile/login-activity", SA, superadmin_controller_1.getLoginActivity);
// ─── Overview ─────────────────────────────────────────────────────────────────
router.get("/overview", SA, superadmin_controller_1.getOverview);
// ─── Institutions ─────────────────────────────────────────────────────────────
router.post("/institutions", SA, superadmin_controller_1.createInstitution);
router.post("/institutions/logo", SA, (0, express_1.raw)({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }), superadmin_controller_1.uploadInstitutionLogo);
router.get("/institutions", SA, superadmin_controller_1.getInstitutions);
router.get("/institutions/:id", SA, superadmin_controller_1.getInstitution);
router.put("/institutions/:id", SA, superadmin_controller_1.updateInstitution);
router.patch("/institutions/:id/status", SA, superadmin_controller_1.toggleStatus);
router.post("/institutions/:id/resend-invite", SA, superadmin_controller_1.resendInvite);
// ─── Plan Management ──────────────────────────────────────────────────────────
router.get("/plans", SA, superadmin_controller_1.getPlans);
router.get("/institutions/:id/plan", SA, superadmin_controller_1.getInstitutionPlan);
router.patch("/institutions/:id/plan", SA, superadmin_controller_1.updateInstitutionPlan);
router.patch("/institutions/:id/features", SA, superadmin_controller_1.updateInstitutionFeatures);
// ─── Audit Logs ───────────────────────────────────────────────────────────────
router.get("/audit-logs", SA, superadmin_controller_1.getAuditLogs);
// ─── Notifications ────────────────────────────────────────────────────────────
router.post("/notifications", SA, superadmin_controller_1.broadcastNotification);
router.get("/notifications", SA, superadmin_controller_1.getNotifications);
// ─── Support — Tickets ────────────────────────────────────────────────────────
router.get("/support/tickets", SA, superadmin_controller_1.getTickets);
router.get("/support/tickets/:id", SA, superadmin_controller_1.getTicket);
router.patch("/support/tickets/:id/status", SA, superadmin_controller_1.updateTicketStatus);
router.post("/support/tickets/:id/reply", SA, superadmin_controller_1.replyToTicket);
// ─── Support — Reviews ────────────────────────────────────────────────────────
router.get("/support/reviews", SA, superadmin_controller_1.getReviews);
router.post("/support/reviews/:id/reply", SA, superadmin_controller_1.replyToReview);
// ─── System & AI ─────────────────────────────────────────────────────────────
router.get("/system/health", SA, superadmin_controller_1.getSystemHealth);
router.get("/system/ai-usage", SA, superadmin_controller_1.getAIUsage);
// ─── Vault ────────────────────────────────────────────────────────────────────
router.get("/vault/stats", SA, superadmin_controller_1.getVaultStats);
exports.default = router;
