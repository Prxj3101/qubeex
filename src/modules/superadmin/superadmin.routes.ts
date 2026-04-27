import { Router, raw } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import {
  // Profile
  getProfile,
  updateProfile,
  changePassword,
  getLoginActivity,
  // Overview
  getOverview,
  // Institutions
  createInstitution,
  getInstitutions,
  getInstitution,
  updateInstitution,
  uploadInstitutionLogo,
  toggleStatus,
  resendInvite,
  // Audit Logs
  getAuditLogs,
  // Plans
  getPlans,
  getInstitutionPlan,
  updateInstitutionPlan,
  updateInstitutionFeatures,
  // Notifications
  broadcastNotification,
  getNotifications,
  // Tickets
  getTickets,
  getTicket,
  updateTicketStatus,
  replyToTicket,
  // Reviews
  getReviews,
  replyToReview,
  // System
  getSystemHealth,
  getAIUsage,
  // Vault
  getVaultStats,
} from "./superadmin.controller";

const router = Router();
const SA = authMiddleware(["SUPER_ADMIN"]);

// ─── Profile ─────────────────────────────────────────────────────────────────
router.get("/profile",                                 SA, getProfile);
router.put("/profile",                                 SA, updateProfile);
router.put("/profile/password",                        SA, changePassword);
router.get("/profile/login-activity",                  SA, getLoginActivity);

// ─── Overview ─────────────────────────────────────────────────────────────────
router.get("/overview", SA, getOverview);

// ─── Institutions ─────────────────────────────────────────────────────────────
router.post("/institutions",                           SA, createInstitution);
router.post("/institutions/logo",                      SA, raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }), uploadInstitutionLogo);
router.get("/institutions",                            SA, getInstitutions);
router.get("/institutions/:id",                        SA, getInstitution);
router.put("/institutions/:id",                        SA, updateInstitution);
router.patch("/institutions/:id/status",               SA, toggleStatus);
router.post("/institutions/:id/resend-invite",         SA, resendInvite);

// ─── Plan Management ──────────────────────────────────────────────────────────
router.get("/plans",                                   SA, getPlans);
router.get("/institutions/:id/plan",                   SA, getInstitutionPlan);
router.patch("/institutions/:id/plan",                 SA, updateInstitutionPlan);
router.patch("/institutions/:id/features",             SA, updateInstitutionFeatures);

// ─── Audit Logs ───────────────────────────────────────────────────────────────
router.get("/audit-logs",                              SA, getAuditLogs);

// ─── Notifications ────────────────────────────────────────────────────────────
router.post("/notifications",                          SA, broadcastNotification);
router.get("/notifications",                           SA, getNotifications);

// ─── Support — Tickets ────────────────────────────────────────────────────────
router.get("/support/tickets",                         SA, getTickets);
router.get("/support/tickets/:id",                     SA, getTicket);
router.patch("/support/tickets/:id/status",            SA, updateTicketStatus);
router.post("/support/tickets/:id/reply",              SA, replyToTicket);

// ─── Support — Reviews ────────────────────────────────────────────────────────
router.get("/support/reviews",                         SA, getReviews);
router.post("/support/reviews/:id/reply",              SA, replyToReview);

// ─── System & AI ─────────────────────────────────────────────────────────────
router.get("/system/health",                           SA, getSystemHealth);
router.get("/system/ai-usage",                         SA, getAIUsage);

// ─── Vault ────────────────────────────────────────────────────────────────────
router.get("/vault/stats",                             SA, getVaultStats);

export default router;
