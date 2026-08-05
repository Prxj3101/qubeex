import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { BadRequestError } from "../../utils/errors";
import * as service from "./superadmin.service";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");

export const ticketAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});
import {
  updateProfileSchema,
  changePasswordSchema,
  createInstitutionSchema,
  updateInstitutionSchema,
  updateInstitutionAdminSchema,
  toggleStatusSchema,
  updatePlanSchema,
  updateFeaturesSchema,
  activatePlanSchema,
  broadcastNotificationSchema,
  updateTicketStatusSchema,
  ticketReplySchema,
  reviewReplySchema,
  updateBillStatusSchema,
  updatePaymentSettingsSchema,
  updateAddonsSchema,
} from "./superadmin.schema";

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE
// ─────────────────────────────────────────────────────────────────────────────

export const getProfile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getProfile(req.user!.userId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updateProfile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = updateProfileSchema.parse(req.body);
    const result = await service.updateProfile(req.user!.userId, data);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const changePassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = changePasswordSchema.parse(req.body);
    const result = await service.changeProfilePassword(req.user!.userId, data);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getLoginActivity = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { limit } = req.query as Record<string, string>;
    const data = await service.getProfileLoginActivity(
      req.user!.userId,
      limit ? parseInt(limit) : 10
    );
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────

export const getOverview = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getOverviewStats();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTITUTIONS
// ─────────────────────────────────────────────────────────────────────────────

export const createInstitution = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = createInstitutionSchema.parse(req.body);
    const result = await service.createInstitutionService(data);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getInstitutions = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getInstitution();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getInstitution = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getInstitutionById(req.params.id as string);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updateInstitution = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = updateInstitutionSchema.parse(req.body);
    const result = await service.updateInstitution(req.params.id as string, data);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const updateInstitutionAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = updateInstitutionAdminSchema.parse(req.body);
    const result = await service.updateInstitutionAdmin(req.params.id as string, data);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const uploadInstitutionLogo = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const file = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await service.uploadInstitutionLogo(
      file,
      req.headers["content-type"] ?? "",
      req.user?.userId
    );
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const toggleStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status } = toggleStatusSchema.parse(req.body);
    const result = await service.toggleInstitutionStatus(
      req.params.id as string,
      status,
      req.user?.userId,
      req.user?.role
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const activateTrial = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.activateTrial(req.params.id as string, req.user?.userId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getTrialUsage = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getTrialUsage(req.params.id as string);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const deleteInstitution = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    await service.deleteInstitution(req.params.id as string, req.user?.userId);
    res.json({ success: true, message: "Institution permanently deleted" });
  } catch (error) {
    next(error);
  }
};

export const resendInvite = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email } = req.body;
    const result = await service.resendInvite(email, req.params.id as string);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const extendTrial = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { extraDays } = req.body;
    if (!extraDays || typeof extraDays !== 'number') {
      return res.status(400).json({ success: false, message: 'extraDays is required and must be a number' });
    }
    const result = await service.extendTrial(
      req.params.id as string,
      extraDays,
      req.user?.userId
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const markTrialChurned = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = await service.markTrialChurned(
      req.params.id as string,
      req.user?.userId
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────

export const getAuditLogs = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { action, institutionId, actorRole, from, to, page, limit } = req.query as Record<string, string>;
    const data = await service.getAuditLogs({
      action,
      institutionId,
      actorRole,
      from,
      to,
      page:  page  ? parseInt(page)  : 1,
      limit: limit ? parseInt(limit) : 20,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PLAN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

export const getPlans = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getPlans();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getInstitutionPlan = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getInstitutionPlan(req.params.id as string);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getInstitutionPlanDashboard = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getInstitutionPlanDashboard(req.params.id as string);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updateInstitutionPlan = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = updatePlanSchema.parse(req.body);
    const result = await service.updateInstitutionPlan(
      req.params.id as string,
      data,
      req.user?.userId,
      req.user?.role
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const updateInstitutionFeatures = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { features } = updateFeaturesSchema.parse(req.body);
    const result = await service.updateInstitutionFeatures(req.params.id as string, features);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const activateInstitutionPlan = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { plan, discountPct, paymentReceived } = activatePlanSchema.parse(req.body);
    const result = await service.activateInstitutionPlan(
      req.params.id as string,
      plan,
      discountPct,
      paymentReceived,
      req.user?.userId
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const broadcastNotification = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = broadcastNotificationSchema.parse(req.body);
    const result = await service.broadcastNotification(data, req.user?.userId);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getNotifications = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { page, limit } = req.query as Record<string, string>;
    const data = await service.getNotifications(
      page  ? parseInt(page)  : 1,
      limit ? parseInt(limit) : 20
    );
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
};

export const getNotificationFeed = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { limit } = req.query as Record<string, string>;
    const data = await service.getSuperadminNotificationFeed(limit ? parseInt(limit) : 20);
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT TICKETS
// ─────────────────────────────────────────────────────────────────────────────

export const getTickets = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status, category, search, page, limit } = req.query as Record<string, string>;
    const data = await service.getTickets({
      status, category, search,
      page:  page  ? parseInt(page)  : 1,
      limit: limit ? parseInt(limit) : 20,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
};

export const getTicket = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getTicketById(req.params.id as string);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updateTicketStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status } = updateTicketStatusSchema.parse(req.body);
    const result = await service.updateTicketStatus(req.params.id as string, status);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const replyToTicket = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { message, attachments } = ticketReplySchema.parse(req.body);
    const result = await service.replyToTicket(req.params.id as string, message, attachments);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const uploadTicketReplyAttachment = async (
  req: AuthRequest & { file?: Express.Multer.File },
  res: Response,
  next: NextFunction
) => {
  try {
    const file = req.file;
    if (!file) throw new BadRequestError("No file provided");
    const result = await service.uploadTicketReplyAttachment(req.params.id as string, file);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REVIEWS
// ─────────────────────────────────────────────────────────────────────────────

export const getReviews = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { type, rating, search, page, limit } = req.query as Record<string, string>;
    const data = await service.getReviews({
      type, search,
      rating: rating ? parseInt(rating) : undefined,
      page:   page   ? parseInt(page)   : 1,
      limit:  limit  ? parseInt(limit)  : 20,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
};

export const replyToReview = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { message } = reviewReplySchema.parse(req.body);
    const result = await service.replyToReview(req.params.id as string, message);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const likeReview = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = await service.likeReview(req.params.id as string);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

export const getSystemHealth = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getSystemHealth();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getAIUsage = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { range = "1M" } = req.query as { range?: string };
    const data = await service.getAIUsage(range);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// VAULT
// ─────────────────────────────────────────────────────────────────────────────

export const getVaultStats = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await service.getVaultStats();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// BILLING
// ─────────────────────────────────────────────────────────────────────────────

export const getBills = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = req.query as Record<string, string>;
    const data = await service.getBills(
      req.params.id as string,
      page  ? parseInt(page)  : 1,
      limit ? parseInt(limit) : 20
    );
    res.json({ success: true, ...data });
  } catch (error) { next(error); }
};

export const updateBillStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { status, paymentMethod } = updateBillStatusSchema.parse(req.body);
    const result = await service.updateBillStatus(req.params.billId as string, status, req.user?.userId, paymentMethod);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

export const getPaymentSettings = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const settings = await service.getPaymentSettings();
    res.json({ success: true, data: settings });
  } catch (error) { next(error); }
};

export const updatePaymentSettings = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = updatePaymentSettingsSchema.parse(req.body);
    const settings = await service.updatePaymentSettings(data, req.user?.userId);
    res.json({ success: true, data: settings });
  } catch (error) { next(error); }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADDONS
// ─────────────────────────────────────────────────────────────────────────────

export const updateAddons = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { addons } = updateAddonsSchema.parse(req.body);
    const result = await service.updateAddons(req.params.id as string, addons as any, req.user?.userId);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

export const resendBill = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await service.resendBill(req.params.id as string, req.params.billId as string);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE / DOWNGRADE
// ─────────────────────────────────────────────────────────────────────────────

export const upgradePlan = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await service.upgradePlan(req.params.id as string, req.user?.userId);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

export const downgradePlan = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await service.downgradePlan(req.params.id as string, req.user?.userId);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

// ─────────────────────────────────────────────────────────────────────────────
// BILLING — Manual Trigger
// ─────────────────────────────────────────────────────────────────────────────

import { generateMonthlyBills } from "../../services/billing.service";

export const runMonthlyBilling = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await generateMonthlyBills();
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};
