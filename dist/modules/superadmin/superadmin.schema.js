"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewReplySchema = exports.ticketReplySchema = exports.updateTicketStatusSchema = exports.broadcastNotificationSchema = exports.updateFeaturesSchema = exports.updatePlanSchema = exports.toggleStatusSchema = exports.updateInstitutionSchema = exports.createInstitutionSchema = exports.changePasswordSchema = exports.updateProfileSchema = void 0;
const zod_1 = require("zod");
const auth_schema_1 = require("../auth/auth.schema");
// ─── Profile ─────────────────────────────────────────────────────────────────
exports.updateProfileSchema = zod_1.z.object({
    name: zod_1.z.string().min(2, "Name must be at least 2 characters").max(200).trim(),
    email: auth_schema_1.emailSchema,
});
exports.changePasswordSchema = zod_1.z.object({
    oldPassword: zod_1.z.string().min(1, "Current password is required").max(100),
    newPassword: auth_schema_1.passwordSchema,
});
// ─── Institution Create ───────────────────────────────────────────────────────
exports.createInstitutionSchema = zod_1.z.object({
    // Core
    name: zod_1.z.string().min(2, "Name must be at least 2 characters").max(200).trim(),
    email: auth_schema_1.emailSchema,
    type: zod_1.z.enum(["SCHOOL", "COLLEGE", "COACHING"]),
    // Admin
    adminName: zod_1.z.string().min(2, "Admin name must be at least 2 characters").max(200).trim(),
    adminEmail: auth_schema_1.emailSchema,
    // Contact & Location
    phone: zod_1.z.string().max(20).trim().optional(),
    city: zod_1.z.string().max(100).trim().optional(),
    state: zod_1.z.string().max(100).trim().optional(),
    address: zod_1.z.string().max(500).trim().optional(),
    pincode: zod_1.z.string().max(10).trim().optional(),
    country: zod_1.z.string().max(100).trim().optional(),
    // Academic
    board: zod_1.z.string().max(100).trim().optional(),
    medium: zod_1.z.string().max(100).trim().optional(),
    logoUrl: zod_1.z.string().url().optional(),
    // Subscription
    plan: zod_1.z.enum(["BASIC", "PRO"]).default("BASIC"),
});
// ─── Institution Update ───────────────────────────────────────────────────────
exports.updateInstitutionSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(200).trim().optional(),
    email: auth_schema_1.emailSchema.optional(),
    type: zod_1.z.enum(["SCHOOL", "COLLEGE", "COACHING"]).optional(),
    phone: zod_1.z.string().max(20).trim().optional(),
    city: zod_1.z.string().max(100).trim().optional(),
    state: zod_1.z.string().max(100).trim().optional(),
    address: zod_1.z.string().max(500).trim().optional(),
    pincode: zod_1.z.string().max(10).trim().optional(),
    country: zod_1.z.string().max(100).trim().optional(),
    board: zod_1.z.string().max(100).trim().optional(),
    medium: zod_1.z.string().max(100).trim().optional(),
    logoUrl: zod_1.z.string().url().optional(),
});
// ─── Status Toggle ────────────────────────────────────────────────────────────
exports.toggleStatusSchema = zod_1.z.object({
    status: zod_1.z.enum(["ACTIVE", "SUSPENDED", "PENDING"]),
});
// ─── Plan Update ──────────────────────────────────────────────────────────────
exports.updatePlanSchema = zod_1.z.object({
    planName: zod_1.z.enum(["BASIC", "PRO"]),
    discount: zod_1.z.number().min(0).max(100).default(0),
    paymentStatus: zod_1.z.enum(["PAID", "PENDING", "FAILED"]),
});
exports.updateFeaturesSchema = zod_1.z.object({
    features: zod_1.z.record(zod_1.z.string(), zod_1.z.boolean()),
});
// ─── Notifications ────────────────────────────────────────────────────────────
exports.broadcastNotificationSchema = zod_1.z.object({
    title: zod_1.z.string().min(1).max(80).trim(),
    message: zod_1.z.string().min(1).max(500).trim(),
    tag: zod_1.z.enum(["ANNOUNCEMENT", "MAINTENANCE", "UPDATE", "FEATURE", "BUG_FIXED", "PLAN_EXPIRY", "SECURITY"]),
    recipient: zod_1.z.enum(["ALL", "SCHOOL", "COLLEGE", "COACHING", "SPECIFIC"]),
    institutionIds: zod_1.z.array(zod_1.z.string()).optional(),
});
// ─── Support Tickets ─────────────────────────────────────────────────────────
exports.updateTicketStatusSchema = zod_1.z.object({
    status: zod_1.z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]),
});
exports.ticketReplySchema = zod_1.z.object({
    message: zod_1.z.string().min(1).max(2000).trim(),
});
// ─── Reviews ─────────────────────────────────────────────────────────────────
exports.reviewReplySchema = zod_1.z.object({
    message: zod_1.z.string().min(1).max(1000).trim(),
});
