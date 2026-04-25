import { z } from "zod";
import { emailSchema } from "../auth/auth.schema";

// ─── Institution Create ───────────────────────────────────────────────────────

export const createInstitutionSchema = z.object({
  // Core
  name: z.string().min(2, "Name must be at least 2 characters").max(200).trim(),
  email: emailSchema,
  type: z.enum(["SCHOOL", "COLLEGE", "COACHING"]),

  // Admin
  adminName: z.string().min(2, "Admin name must be at least 2 characters").max(200).trim(),
  adminEmail: emailSchema,

  // Contact & Location
  phone:   z.string().max(20).trim().optional(),
  city:    z.string().max(100).trim().optional(),
  state:   z.string().max(100).trim().optional(),
  address: z.string().max(500).trim().optional(),
  pincode: z.string().max(10).trim().optional(),
  country: z.string().max(100).trim().optional(),

  // Academic
  board:   z.string().max(100).trim().optional(),
  medium:  z.string().max(100).trim().optional(),
  logoUrl: z.string().url().optional(),

  // Subscription
  plan: z.enum(["BASIC", "PRO"]).default("BASIC"),
});

// ─── Institution Update ───────────────────────────────────────────────────────

export const updateInstitutionSchema = z.object({
  name:    z.string().min(2).max(200).trim().optional(),
  email:   emailSchema.optional(),
  type:    z.enum(["SCHOOL", "COLLEGE", "COACHING"]).optional(),
  phone:   z.string().max(20).trim().optional(),
  city:    z.string().max(100).trim().optional(),
  state:   z.string().max(100).trim().optional(),
  address: z.string().max(500).trim().optional(),
  pincode: z.string().max(10).trim().optional(),
  country: z.string().max(100).trim().optional(),
  board:   z.string().max(100).trim().optional(),
  medium:  z.string().max(100).trim().optional(),
  logoUrl: z.string().url().optional(),
});

// ─── Status Toggle ────────────────────────────────────────────────────────────

export const toggleStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "PENDING"]),
});

// ─── Plan Update ──────────────────────────────────────────────────────────────

export const updatePlanSchema = z.object({
  planName:      z.enum(["BASIC", "PRO"]),
  discount:      z.number().min(0).max(100).default(0),
  paymentStatus: z.enum(["PAID", "PENDING", "FAILED"]),
});

export const updateFeaturesSchema = z.object({
  features: z.record(z.string(), z.boolean()),
});

// ─── Notifications ────────────────────────────────────────────────────────────

export const broadcastNotificationSchema = z.object({
  title:          z.string().min(1).max(80).trim(),
  message:        z.string().min(1).max(500).trim(),
  tag:            z.enum(["ANNOUNCEMENT", "MAINTENANCE", "UPDATE", "FEATURE", "BUG_FIXED", "PLAN_EXPIRY", "SECURITY"]),
  recipient:      z.enum(["ALL", "SCHOOL", "COLLEGE", "COACHING", "SPECIFIC"]),
  institutionIds: z.array(z.string()).optional(),
});

// ─── Support Tickets ─────────────────────────────────────────────────────────

export const updateTicketStatusSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]),
});

export const ticketReplySchema = z.object({
  message: z.string().min(1).max(2000).trim(),
});

// ─── Reviews ─────────────────────────────────────────────────────────────────

export const reviewReplySchema = z.object({
  message: z.string().min(1).max(1000).trim(),
});