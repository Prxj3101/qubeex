import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import * as service from "./superadmin.service";
import {
  createInstitutionSchema,
  updateInstitutionSchema,
  toggleStatusSchema,
  updatePlanSchema,
  updateFeaturesSchema,
  broadcastNotificationSchema,
  updateTicketStatusSchema,
  ticketReplySchema,
  reviewReplySchema,
} from "./superadmin.schema";

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
    const { message } = ticketReplySchema.parse(req.body);
    const result = await service.replyToTicket(req.params.id as string, message);
    res.status(201).json({ success: true, data: result });
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