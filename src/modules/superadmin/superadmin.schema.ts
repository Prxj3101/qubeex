import { z } from "zod";
import { emailSchema, passwordSchema } from "../auth/auth.schema";

// ─── Profile ─────────────────────────────────────────────────────────────────

export const updateProfileSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(200).trim(),
  email: emailSchema,
});

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, "Current password is required").max(100),
  newPassword: passwordSchema,
});

// ─── BYOD: institution data-storage configuration ─────────────────────────────

export const dbConfigSchema = z.object({
  mode: z.enum(["MANAGED", "BYOD"]),
  engine: z.enum(["POSTGRES", "MYSQL", "SQLSERVER"]).optional(),
  host: z.string().trim().max(255).optional(),
  port: z.number().int().positive().max(65535).optional(),
  databaseName: z.string().trim().max(255).optional(),
  username: z.string().trim().max(255).optional(),
  password: z.string().max(500).optional(),
  sslMode: z.enum(["disable", "require", "verify-full"]).optional(),
  sslCaCert: z.string().max(20000).optional().nullable(),
});

// ─── Institution Create ───────────────────────────────────────────────────────

export const createInstitutionSchema = z.object({
  // Core
  name: z.string().min(2, "Name must be at least 2 characters").max(200).trim(),
  email: emailSchema,
  type: z.enum(["SCHOOL", "COLLEGE", "COACHING"]),
  abbreviation: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/, "Abbreviation must be exactly 4 letters/digits"),

  // Admin
  adminName: z.string().min(2, "Admin name must be at least 2 characters").max(200).trim(),
  adminEmail: emailSchema,
  adminPhone:  z.string().max(20).trim().optional(),
  adminDob:    z.string().optional(),
  adminGender: z.string().optional(),

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
  establishedOn: z.string().optional(),

  // Subscription
  plan: z.enum(["BASIC", "PRO", "TRIAL"]).default("BASIC"),
  trialDays: z.coerce.number().int().min(1).max(365).default(14),

  // Demo institute — gets code ending in 0000, excluded from dashboard totals
  isDemo: z.boolean().default(false),
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
  establishedOn: z.string().optional(),
});

// ─── Institution Admin Update (superadmin editing the institution's admin) ────

export const updateInstitutionAdminSchema = z.object({
  adminName:   z.string().min(2).max(200).trim().optional(),
  adminEmail:  emailSchema.optional(),
  adminPhone:  z.string().max(20).trim().optional(),
  adminDob:    z.string().optional(),
  adminGender: z.string().optional(),
  adminPrefix: z.string().max(20).trim().optional(),
  adminTitle:  z.string().max(100).trim().optional(),
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

export const activatePlanSchema = z.object({
  plan: z.enum(["BASIC", "PRO"]),
  paymentReceived: z
    .boolean()
    .refine((value) => value === true, "License payment must be marked as received to activate plan"),
  discountPct: z.number().min(0).max(100).default(0),
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

const ticketAttachmentSchema = z.object({
  url: z.string().url(),
  name: z.string().max(200),
  type: z.enum(["image", "video", "file"]),
  size: z.number().int().nonnegative(),
});

export const ticketReplySchema = z.object({
  message: z.string().min(1).max(2000).trim(),
  attachments: z.array(ticketAttachmentSchema).max(5).optional(),
});

// ─── Reviews ─────────────────────────────────────────────────────────────────

export const reviewReplySchema = z.object({
  message: z.string().min(1).max(1000).trim(),
});

// ─── Billing ──────────────────────────────────────────────────────────────────

export const updateBillStatusSchema = z.object({
  status: z.enum(["PAID", "PENDING"]),
  paymentMethod: z.enum(["cash", "bank_transfer", "manual"]).optional(),
});

// ─── Platform Payment Settings ─────────────────────────────────────────────────

export const updatePaymentSettingsSchema = z.object({
  bankAccountName: z.string().trim().max(200).optional().or(z.literal("")),
  bankAccountNumber: z.string().trim().max(50).optional().or(z.literal("")),
  bankIfsc: z.string().trim().max(20).optional().or(z.literal("")),
  bankName: z.string().trim().max(200).optional().or(z.literal("")),
  upiId: z.string().trim().max(100).optional().or(z.literal("")),
});

const addonBillingCycleSchema = z.enum(["MONTHLY", "YEARLY"]);

const featureAddonSchema = z.object({
  active: z.boolean(),
  billingCycle: addonBillingCycleSchema,
  amount: z.number().nonnegative(),
});

const smartBoardAddonSchema = z.object({
  active: z.boolean(),
  isInFreePeriod: z.boolean(),
  freeStartDate: z.string().datetime().optional(),
  freeEndDate: z.string().datetime().optional(),
  billingCycle: addonBillingCycleSchema.nullable(),
  amount: z.number().nonnegative().nullable(),
  autoEnabledBySystem: z.boolean().optional(),
  freeExpiry30DayAlertSent: z.boolean().optional(),
});

const aiTokenAddonRequestSchema = z.union([
  z.object({ active: z.literal(false) }),
  z.object({
    active: z.literal(true),
    tokensPerMonth: z.number().int().positive(),
    pricePerMillion: z.number().positive("Price per million tokens must be greater than 0"),
  }),
]);

const storageAddonEntrySchema = z.object({
  gbPurchased: z.number().int().positive(),
  price: z.number().positive("Price must be greater than 0"),
});

export const updateAddonsSchema = z.object({
  addons: z
    .object({
      smartBoardAi: smartBoardAddonSchema.optional(),
      performanceInsightsAndAnalytics: featureAddonSchema.optional(),
      timetableAutoScheduling: featureAddonSchema.optional(),
      aiTokenAddon: aiTokenAddonRequestSchema.optional(),
      extraStorage: z.array(storageAddonEntrySchema).optional(),
    })
    .strict(),
});
