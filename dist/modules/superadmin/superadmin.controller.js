"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMonthlyBilling = exports.downgradePlan = exports.upgradePlan = exports.updateAddons = exports.resumeInstitution = exports.pauseInstitution = exports.updateBillStatus = exports.getBills = exports.getVaultStats = exports.getAIUsage = exports.getSystemHealth = exports.replyToReview = exports.getReviews = exports.replyToTicket = exports.updateTicketStatus = exports.getTicket = exports.getTickets = exports.getNotifications = exports.broadcastNotification = exports.activateInstitutionPlan = exports.updateInstitutionFeatures = exports.updateInstitutionPlan = exports.getInstitutionPlanDashboard = exports.getInstitutionPlan = exports.getPlans = exports.getAuditLogs = exports.markTrialChurned = exports.extendTrial = exports.resendInvite = exports.deleteInstitution = exports.getTrialUsage = exports.toggleStatus = exports.uploadInstitutionLogo = exports.updateInstitution = exports.getInstitution = exports.getInstitutions = exports.createInstitution = exports.getOverview = exports.getLoginActivity = exports.changePassword = exports.updateProfile = exports.getProfile = void 0;
const service = __importStar(require("./superadmin.service"));
const superadmin_schema_1 = require("./superadmin.schema");
// ─────────────────────────────────────────────────────────────────────────────
// PROFILE
// ─────────────────────────────────────────────────────────────────────────────
const getProfile = async (req, res, next) => {
    try {
        const data = await service.getProfile(req.user.userId);
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getProfile = getProfile;
const updateProfile = async (req, res, next) => {
    try {
        const data = superadmin_schema_1.updateProfileSchema.parse(req.body);
        const result = await service.updateProfile(req.user.userId, data);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.updateProfile = updateProfile;
const changePassword = async (req, res, next) => {
    try {
        const data = superadmin_schema_1.changePasswordSchema.parse(req.body);
        const result = await service.changeProfilePassword(req.user.userId, data);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.changePassword = changePassword;
const getLoginActivity = async (req, res, next) => {
    try {
        const { limit } = req.query;
        const data = await service.getProfileLoginActivity(req.user.userId, limit ? parseInt(limit) : 10);
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getLoginActivity = getLoginActivity;
// ─────────────────────────────────────────────────────────────────────────────
// OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────
const getOverview = async (_req, res, next) => {
    try {
        const data = await service.getOverviewStats();
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getOverview = getOverview;
// ─────────────────────────────────────────────────────────────────────────────
// INSTITUTIONS
// ─────────────────────────────────────────────────────────────────────────────
const createInstitution = async (req, res, next) => {
    try {
        const data = superadmin_schema_1.createInstitutionSchema.parse(req.body);
        const result = await service.createInstitutionService(data);
        res.status(201).json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.createInstitution = createInstitution;
const getInstitutions = async (_req, res, next) => {
    try {
        const data = await service.getInstitution();
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getInstitutions = getInstitutions;
const getInstitution = async (req, res, next) => {
    try {
        const data = await service.getInstitutionById(req.params.id);
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getInstitution = getInstitution;
const updateInstitution = async (req, res, next) => {
    try {
        const data = superadmin_schema_1.updateInstitutionSchema.parse(req.body);
        const result = await service.updateInstitution(req.params.id, data);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.updateInstitution = updateInstitution;
const uploadInstitutionLogo = async (req, res, next) => {
    try {
        const file = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const result = await service.uploadInstitutionLogo(file, req.headers["content-type"] ?? "", req.user?.userId);
        res.status(201).json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.uploadInstitutionLogo = uploadInstitutionLogo;
const toggleStatus = async (req, res, next) => {
    try {
        const { status } = superadmin_schema_1.toggleStatusSchema.parse(req.body);
        const result = await service.toggleInstitutionStatus(req.params.id, status, req.user?.userId, req.user?.role);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.toggleStatus = toggleStatus;
const getTrialUsage = async (req, res, next) => {
    try {
        const data = await service.getTrialUsage(req.params.id);
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getTrialUsage = getTrialUsage;
const deleteInstitution = async (req, res, next) => {
    try {
        await service.deleteInstitution(req.params.id, req.user?.userId);
        res.json({ success: true, message: "Institution permanently deleted" });
    }
    catch (error) {
        next(error);
    }
};
exports.deleteInstitution = deleteInstitution;
const resendInvite = async (req, res, next) => {
    try {
        const { email } = req.body;
        const result = await service.resendInvite(email, req.params.id);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.resendInvite = resendInvite;
const extendTrial = async (req, res, next) => {
    try {
        const { extraDays } = req.body;
        if (!extraDays || typeof extraDays !== 'number') {
            return res.status(400).json({ success: false, message: 'extraDays is required and must be a number' });
        }
        const result = await service.extendTrial(req.params.id, extraDays, req.user?.userId);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.extendTrial = extendTrial;
const markTrialChurned = async (req, res, next) => {
    try {
        const result = await service.markTrialChurned(req.params.id, req.user?.userId);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.markTrialChurned = markTrialChurned;
// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────
const getAuditLogs = async (req, res, next) => {
    try {
        const { action, institutionId, actorRole, from, to, page, limit } = req.query;
        const data = await service.getAuditLogs({
            action,
            institutionId,
            actorRole,
            from,
            to,
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 20,
        });
        res.json({ success: true, ...data });
    }
    catch (error) {
        next(error);
    }
};
exports.getAuditLogs = getAuditLogs;
// ─────────────────────────────────────────────────────────────────────────────
// PLAN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
const getPlans = async (_req, res, next) => {
    try {
        const data = await service.getPlans();
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getPlans = getPlans;
const getInstitutionPlan = async (req, res, next) => {
    try {
        const data = await service.getInstitutionPlan(req.params.id);
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getInstitutionPlan = getInstitutionPlan;
const getInstitutionPlanDashboard = async (req, res, next) => {
    try {
        const data = await service.getInstitutionPlanDashboard(req.params.id);
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getInstitutionPlanDashboard = getInstitutionPlanDashboard;
const updateInstitutionPlan = async (req, res, next) => {
    try {
        const data = superadmin_schema_1.updatePlanSchema.parse(req.body);
        const result = await service.updateInstitutionPlan(req.params.id, data, req.user?.userId, req.user?.role);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.updateInstitutionPlan = updateInstitutionPlan;
const updateInstitutionFeatures = async (req, res, next) => {
    try {
        const { features } = superadmin_schema_1.updateFeaturesSchema.parse(req.body);
        const result = await service.updateInstitutionFeatures(req.params.id, features);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.updateInstitutionFeatures = updateInstitutionFeatures;
const activateInstitutionPlan = async (req, res, next) => {
    try {
        const { plan, discountPct, paymentReceived } = superadmin_schema_1.activatePlanSchema.parse(req.body);
        const result = await service.activateInstitutionPlan(req.params.id, plan, discountPct, paymentReceived, req.user?.userId);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.activateInstitutionPlan = activateInstitutionPlan;
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
const broadcastNotification = async (req, res, next) => {
    try {
        const data = superadmin_schema_1.broadcastNotificationSchema.parse(req.body);
        const result = await service.broadcastNotification(data, req.user?.userId);
        res.status(201).json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.broadcastNotification = broadcastNotification;
const getNotifications = async (req, res, next) => {
    try {
        const { page, limit } = req.query;
        const data = await service.getNotifications(page ? parseInt(page) : 1, limit ? parseInt(limit) : 20);
        res.json({ success: true, ...data });
    }
    catch (error) {
        next(error);
    }
};
exports.getNotifications = getNotifications;
// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT TICKETS
// ─────────────────────────────────────────────────────────────────────────────
const getTickets = async (req, res, next) => {
    try {
        const { status, category, search, page, limit } = req.query;
        const data = await service.getTickets({
            status, category, search,
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 20,
        });
        res.json({ success: true, ...data });
    }
    catch (error) {
        next(error);
    }
};
exports.getTickets = getTickets;
const getTicket = async (req, res, next) => {
    try {
        const data = await service.getTicketById(req.params.id);
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getTicket = getTicket;
const updateTicketStatus = async (req, res, next) => {
    try {
        const { status } = superadmin_schema_1.updateTicketStatusSchema.parse(req.body);
        const result = await service.updateTicketStatus(req.params.id, status);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.updateTicketStatus = updateTicketStatus;
const replyToTicket = async (req, res, next) => {
    try {
        const { message } = superadmin_schema_1.ticketReplySchema.parse(req.body);
        const result = await service.replyToTicket(req.params.id, message);
        res.status(201).json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.replyToTicket = replyToTicket;
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWS
// ─────────────────────────────────────────────────────────────────────────────
const getReviews = async (req, res, next) => {
    try {
        const { type, rating, search, page, limit } = req.query;
        const data = await service.getReviews({
            type, search,
            rating: rating ? parseInt(rating) : undefined,
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 20,
        });
        res.json({ success: true, ...data });
    }
    catch (error) {
        next(error);
    }
};
exports.getReviews = getReviews;
const replyToReview = async (req, res, next) => {
    try {
        const { message } = superadmin_schema_1.reviewReplySchema.parse(req.body);
        const result = await service.replyToReview(req.params.id, message);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.replyToReview = replyToReview;
// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
const getSystemHealth = async (_req, res, next) => {
    try {
        const data = await service.getSystemHealth();
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getSystemHealth = getSystemHealth;
const getAIUsage = async (req, res, next) => {
    try {
        const { range = "1M" } = req.query;
        const data = await service.getAIUsage(range);
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getAIUsage = getAIUsage;
// ─────────────────────────────────────────────────────────────────────────────
// VAULT
// ─────────────────────────────────────────────────────────────────────────────
const getVaultStats = async (_req, res, next) => {
    try {
        const data = await service.getVaultStats();
        res.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
};
exports.getVaultStats = getVaultStats;
// ─────────────────────────────────────────────────────────────────────────────
// BILLING
// ─────────────────────────────────────────────────────────────────────────────
const getBills = async (req, res, next) => {
    try {
        const { page, limit } = req.query;
        const data = await service.getBills(req.params.id, page ? parseInt(page) : 1, limit ? parseInt(limit) : 20);
        res.json({ success: true, ...data });
    }
    catch (error) {
        next(error);
    }
};
exports.getBills = getBills;
const updateBillStatus = async (req, res, next) => {
    try {
        const { status } = superadmin_schema_1.updateBillStatusSchema.parse(req.body);
        const result = await service.updateBillStatus(req.params.billId, status, req.user?.userId);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.updateBillStatus = updateBillStatus;
// ─────────────────────────────────────────────────────────────────────────────
// PAUSE / RESUME
// ─────────────────────────────────────────────────────────────────────────────
const pauseInstitution = async (req, res, next) => {
    try {
        const result = await service.pauseInstitution(req.params.id, req.user?.userId);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.pauseInstitution = pauseInstitution;
const resumeInstitution = async (req, res, next) => {
    try {
        const result = await service.resumeInstitution(req.params.id, req.user?.userId);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.resumeInstitution = resumeInstitution;
// ─────────────────────────────────────────────────────────────────────────────
// ADDONS
// ─────────────────────────────────────────────────────────────────────────────
const updateAddons = async (req, res, next) => {
    try {
        const { addons } = superadmin_schema_1.updateAddonsSchema.parse(req.body);
        const result = await service.updateAddons(req.params.id, addons, req.user?.userId);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.updateAddons = updateAddons;
// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE / DOWNGRADE
// ─────────────────────────────────────────────────────────────────────────────
const upgradePlan = async (req, res, next) => {
    try {
        const result = await service.upgradePlan(req.params.id, req.user?.userId);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.upgradePlan = upgradePlan;
const downgradePlan = async (req, res, next) => {
    try {
        const result = await service.downgradePlan(req.params.id, req.user?.userId);
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.downgradePlan = downgradePlan;
// ─────────────────────────────────────────────────────────────────────────────
// BILLING — Manual Trigger
// ─────────────────────────────────────────────────────────────────────────────
const billing_service_1 = require("../../services/billing.service");
const runMonthlyBilling = async (req, res, next) => {
    try {
        const result = await (0, billing_service_1.generateMonthlyBills)();
        res.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
};
exports.runMonthlyBilling = runMonthlyBilling;
