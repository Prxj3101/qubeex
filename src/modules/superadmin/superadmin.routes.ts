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
  updateInstitutionAdmin,
  uploadInstitutionLogo,
  toggleStatus,
  getTrialUsage,
  activateTrial,
  getInstitutionDbConfig,
  saveInstitutionDbConfig,
  testInstitutionDbConnection,
  deleteInstitution,
  resendInvite,
  // Audit Logs
  getAuditLogs,
  getPlans,
  getInstitutionUsers,
  getInstitutionPlan,
  getInstitutionPlanDashboard,
  updateInstitutionPlan,
  activateInstitutionPlan,
  changePlanOption,
  updateInstitutionFeatures,
  extendTrial,
  markTrialChurned,
  // Notifications
  broadcastNotification,
  getNotifications,
  getNotificationFeed,
  // Tickets
  getTickets,
  getTicket,
  updateTicketStatus,
  replyToTicket,
  uploadTicketReplyAttachment,
  ticketAttachmentUpload,
  // Demo Requests
  getDemoRequests,
  getDemoRequest,
  updateDemoRequestStatus,
  // Reviews
  getReviews,
  replyToReview,
  likeReview,
  // System
  getSystemHealth,
  getAIUsage,
  getInstitutionAiUsage,
  // Vault
  getVaultStats,
  // Billing
  getBills,
  updateBillStatus,
  getPaymentSettings,
  updatePaymentSettings,
  // Addons
  updateAddons,
  getWhiteLabelConfig,
  updateWhiteLabelConfig,
  uploadWhiteLabelLogo,
  uploadWhiteLabelFavicon,
  resendBill,
  // Upgrade / Downgrade
  upgradePlan,
  downgradePlan,
  runMonthlyBilling,
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
router.patch("/institutions/:id/admin",                 SA, updateInstitutionAdmin);
router.patch("/institutions/:id/status",               SA, toggleStatus);
router.delete("/institutions/:id",                     SA, deleteInstitution);
router.post("/institutions/:id/resend-invite",         SA, resendInvite);

// ─── BYOD: Data Storage Configuration ──────────────────────────────────────────
router.get("/institutions/:id/db-config",              SA, getInstitutionDbConfig);
router.put("/institutions/:id/db-config",              SA, saveInstitutionDbConfig);
router.post("/institutions/:id/db-config/test",        SA, testInstitutionDbConnection);

// ─── Plan Management ──────────────────────────────────────────────────────────
router.get("/plans",                                   SA, getPlans);
router.get("/institutions/:id/users",                  SA, getInstitutionUsers);
router.get("/institutions/:id/plan",                   SA, getInstitutionPlan);
router.get("/institutions/:id/plan/dashboard",         SA, getInstitutionPlanDashboard);
router.patch("/institutions/:id/plan",                 SA, updateInstitutionPlan);
router.post("/institutions/:id/activate",              SA, activateInstitutionPlan);
router.patch("/institutions/:id/plan-option",          SA, changePlanOption);
router.patch("/institutions/:id/features",             SA, updateInstitutionFeatures);
router.get("/institutions/:id/trial/usage",            SA, getTrialUsage);
router.get("/institutions/:id/ai-usage",                SA, getInstitutionAiUsage);
router.post("/institutions/:id/trial/activate",        SA, activateTrial);
router.post("/institutions/:id/trial/extend",          SA, extendTrial);
router.post("/institutions/:id/trial/churn",           SA, markTrialChurned);

// ─── Billing ──────────────────────────────────────────────────────────────────
router.get("/institutions/:id/bills",                       SA, getBills);
router.patch("/institutions/:id/bills/:billId/status",      SA, updateBillStatus);
router.get("/payment-settings",                              SA, getPaymentSettings);
router.patch("/payment-settings",                            SA, updatePaymentSettings);
router.post("/institutions/:id/bills/:billId/resend",       SA, resendBill);

// ─── Addons ───────────────────────────────────────────────────────────────────
router.patch("/institutions/:id/addons",                    SA, updateAddons);

// ─── White-Labeling ───────────────────────────────────────────────────────────
router.get("/institutions/:id/white-label",                 SA, getWhiteLabelConfig);
router.patch("/institutions/:id/white-label",                SA, updateWhiteLabelConfig);
router.post("/institutions/:id/white-label/logo",            SA, raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }), uploadWhiteLabelLogo);
router.post("/institutions/:id/white-label/favicon",         SA, raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }), uploadWhiteLabelFavicon);

// ─── Upgrade / Downgrade ──────────────────────────────────────────────────────
router.post("/institutions/:id/upgrade",               SA, upgradePlan);
router.post("/institutions/:id/downgrade",             SA, downgradePlan);

// ─── Audit Logs ───────────────────────────────────────────────────────────────
router.get("/audit-logs",                              SA, getAuditLogs);

// ─── Notifications ────────────────────────────────────────────────────────────
router.post("/notifications",                          SA, broadcastNotification);
router.get("/notifications/feed",                      SA, getNotificationFeed);
router.get("/notifications",                           SA, getNotifications);

// ─── Support — Tickets ────────────────────────────────────────────────────────
router.get("/support/tickets",                         SA, getTickets);
router.get("/support/tickets/:id",                     SA, getTicket);
router.patch("/support/tickets/:id/status",            SA, updateTicketStatus);
router.post("/support/tickets/:id/reply",              SA, replyToTicket);
router.post("/support/tickets/:id/attachments",         SA, ticketAttachmentUpload.single("file"), uploadTicketReplyAttachment);

// ─── Support — Demo Requests ──────────────────────────────────────────────────
router.get("/demo-requests",                           SA, getDemoRequests);
router.get("/demo-requests/:id",                        SA, getDemoRequest);
router.patch("/demo-requests/:id/status",               SA, updateDemoRequestStatus);

// ─── Support — Reviews ────────────────────────────────────────────────────────
router.get("/support/reviews",                         SA, getReviews);
router.post("/support/reviews/:id/reply",              SA, replyToReview);
router.post("/support/reviews/:id/like",               SA, likeReview);

// ─── System & AI ─────────────────────────────────────────────────────────────
router.get("/system/health",                           SA, getSystemHealth);
router.get("/system/ai-usage",                         SA, getAIUsage);

// ─── Vault ────────────────────────────────────────────────────────────────────
router.get("/vault/stats",                             SA, getVaultStats);

// ─── Billing — Manual Trigger ─────────────────────────────────────────────────
router.post("/billing/run-monthly",                SA, runMonthlyBilling);

export default router;
