import { prisma } from "../../utils/prisma";
import { generateToken, hashToken } from "../../utils/token";
import { sendInviteEmail, sendActivationEmail } from "../../services/email.service";
import { logAudit } from "../../services/audit.service";
import { uploadImageToR2, uploadAttachmentToR2, generateSignedAvatarUrl, getInstitutionStorageBytes, bytesToGb } from "../../services/storage.service";
import {
  generateUpgradeProrationBill,
  markBillPaid,
  PLAN_AI_TOKENS,
} from "../../services/billing.service";
import { cancelPaymentLink } from "../../services/razorpay.service";
import { generateInstitutionCode } from "../../utils/institutionCode";
import { generateUserId } from "../../utils/userId";
import { recordUserStatusEvent } from "../../services/userStatusEvent.service";
import { getInstitutionUsersForMonth } from "../../services/userDirectory.service";
import { getAcademicClient } from "../../services/tenantDb.service";
import type { AcademicClient } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError, TooManyRequestsError } from "../../utils/errors";
import { getInstitutionUsageSummary, getPlatformUsageSummary } from "../../services/ai-usage.service";
import { getCache, setCache, delCache } from "../../utils/cache";
import { redis, isRedisReady } from "../../utils/redis";
import bcrypt from "bcrypt";

const CACHE_KEYS = {
  overview:     "cache:overview",
  institutions: "cache:institutions",
} as const;

const BCRYPT_ROUNDS = 12;

type PlanName = "BASIC" | "PRO";

type FeatureFlags = Record<string, boolean>;

const BASIC_FEATURES: FeatureFlags = {
  studentManagement: true,
  teacherManagement: true,
  courseManagement: true,
  attendanceTracking: true,
  aiQuestionAndTestGeneration: true,
  resultsAndMarksheet: true,
  academicCalendar: true,
  announcementsAndFeed: true,
  timetableManual: true,
  timetableAutomatic: false,
  studentApp: true,
  parentPortal: false,
  submissionsAndResourceSharing: true,
  remarksFlagsWarning: true,
  feesManagement: true,
  performanceInsightsAndAnalytics: false,
  leaderboardSystem: false,
  whitelabelling: false,
};

const PRO_FEATURES: FeatureFlags = {
  ...BASIC_FEATURES,
  timetableAutomatic: true,
  parentPortal: true,
  performanceInsightsAndAnalytics: true,
  leaderboardSystem: true,
  whitelabelling: true,
};

const FIRST_YEAR_FREE_ADDON_KEY = "smartBoardAi";

type SmartBoardAddonState = {
  active: boolean;
  isInFreePeriod: boolean;
  freeStartDate: string;
  freeEndDate: string;
  billingCycle: "MONTHLY" | "YEARLY" | null;
  amount: number | null;
  autoEnabledBySystem: boolean;
  freeExpiry30DayAlertSent: boolean;
};

const getFeatureFlagsForPlan = (planName: PlanName): FeatureFlags => {
  return planName === "PRO" ? PRO_FEATURES : BASIC_FEATURES;
};

const getNextBillingDate = (anchor: Date): Date => {
  return new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
};

const buildSmartBoardFreeAddon = (activationDate: Date): SmartBoardAddonState => {
  const freeEnd = new Date(activationDate);
  freeEnd.setFullYear(freeEnd.getFullYear() + 1);
  return {
    active: true,
    isInFreePeriod: true,
    freeStartDate: activationDate.toISOString(),
    freeEndDate: freeEnd.toISOString(),
    billingCycle: null,
    amount: null,
    autoEnabledBySystem: true,
    freeExpiry30DayAlertSent: false,
  };
};

const toProfileResponse = (user: {
  id: string;
  name: string | null;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  isActive: user.isActive,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const getDeviceName = (userAgent?: string | null) => {
  if (!userAgent || userAgent === "unknown") return "Unknown device";

  const browser = userAgent.includes("Edg/")
    ? "Edge"
    : userAgent.includes("Chrome/")
    ? "Chrome"
    : userAgent.includes("Safari/") && !userAgent.includes("Chrome/")
    ? "Safari"
    : userAgent.includes("Firefox/")
    ? "Firefox"
    : userAgent.includes("OPR/") || userAgent.includes("Opera/")
    ? "Opera"
    : "Browser";

  const os = /iPhone|iPad|iPod/.test(userAgent)
    ? "iOS"
    : userAgent.includes("Android")
    ? "Android"
    : userAgent.includes("Windows")
    ? "Windows"
    : userAgent.includes("Mac OS X") || userAgent.includes("Macintosh")
    ? "macOS"
    : userAgent.includes("Linux")
    ? "Linux"
    : "Unknown OS";

  return `${browser} on ${os}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE
// ─────────────────────────────────────────────────────────────────────────────

export const getProfile = async (userId: string) => {
  const user = await prisma.user.findFirst({
    where: { id: userId, role: "SUPER_ADMIN" },
  });

  if (!user) throw new NotFoundError("Super admin profile not found");

  return toProfileResponse(user);
};

export const updateProfile = async (
  userId: string,
  data: { name: string; email: string }
) => {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!existing || existing.role !== "SUPER_ADMIN") {
    throw new NotFoundError("Super admin profile not found");
  }

  if (data.email !== existing.email) {
    const emailOwner = await prisma.user.findUnique({ where: { email: data.email } });
    if (emailOwner && emailOwner.id !== userId) {
      throw new ConflictError("A user with this email already exists");
    }
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      name: data.name,
      email: data.email,
    },
  });

  logAudit("PROFILE_UPDATED", {
    userId,
    actorRole: "SUPER_ADMIN",
    category: "SECURITY",
    severity: "INFO",
    details: `Super admin profile updated for ${user.email}`,
    metadata: { email: user.email },
  });

  return toProfileResponse(user);
};

export const changeProfilePassword = async (
  userId: string,
  data: { oldPassword: string; newPassword: string }
) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user || user.role !== "SUPER_ADMIN") {
    throw new NotFoundError("Super admin profile not found");
  }
  if (!user.password) throw new BadRequestError("Password is not set for this account");

  const isMatch = await bcrypt.compare(data.oldPassword, user.password);
  if (!isMatch) throw new UnauthorizedError("Current password is incorrect");

  const isSamePassword = await bcrypt.compare(data.newPassword, user.password);
  if (isSamePassword) throw new BadRequestError("New password must be different from current password");

  const hashedPassword = await bcrypt.hash(data.newPassword, BCRYPT_ROUNDS);

  await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword },
  });

  logAudit("PASSWORD_CHANGED", {
    userId,
    actorRole: "SUPER_ADMIN",
    category: "SECURITY",
    severity: "WARNING",
    details: `Password changed for ${user.email}`,
    metadata: { email: user.email },
  });

  return { message: "Password changed successfully" };
};

export const getProfileLoginActivity = async (userId: string, limit = 10) => {
  const logs = await prisma.auditLog.findMany({
    where: {
      action: "LOGIN_SUCCESS",
      userId,
      actorRole: "SUPER_ADMIN",
    },
    take: Math.min(Math.max(limit, 1), 30),
    orderBy: { createdAt: "desc" },
  });

  return logs.map((log, index) => {
    const metadata = log.metadata as { userAgent?: string | null } | null;

    return {
      id: log.id,
      device: getDeviceName(metadata?.userAgent),
      ip: log.ip ?? "unknown",
      location: "Captured by server",
      time: log.createdAt,
      latest: index === 0,
      userAgent: metadata?.userAgent ?? null,
    };
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────

export const getOverviewStats = async () => {
  const cached = await getCache(CACHE_KEYS.overview);
  if (cached) return cached;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - 7);

  const [
    totalInstitutions,
    newInstitutionsThisMonth,
    pendingInvites,
    recentInstitutions,
    recentAuditLogs,
    subscriptions,
  ] = await Promise.all([
    // Demo institute is excluded from every institution count/stat so the
    // dashboard reflects only real (onboarded) institutions.
    prisma.institution.count({ where: { isDemo: false } }),
    prisma.institution.count({ where: { isDemo: false, createdAt: { gte: startOfMonth } } }),
    prisma.invite.count({ where: { isUsed: false, expiresAt: { gt: now } } }),
    prisma.institution.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: {
        subscription: { include: { plan: true } },
        users: { select: { role: true } },
      },
    }),
    prisma.auditLog.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { institution: { select: { id: true, name: true } } },
    }),
    prisma.subscription.findMany({ include: { plan: true } }),
  ]);

  // Plan distribution
  const planCounts: Record<string, number> = {};
  for (const sub of subscriptions) {
    const name = sub.plan.name;
    planCounts[name] = (planCounts[name] ?? 0) + 1;
  }
  const planDistribution = Object.entries(planCounts).map(([plan, count]) => ({ plan, count }));

  // Monthly institution growth (last 6 months)
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    return {
      month: d.toLocaleString("en-IN", { month: "short" }),
      start: d,
      end: new Date(d.getFullYear(), d.getMonth() + 1, 0),
    };
  });

  const institutionGrowth = await Promise.all(
    months.map(async ({ month, start, end }) => {
      const active = await prisma.institution.count({
        where: { createdAt: { gte: start, lte: end }, status: "ACTIVE", isDemo: false },
      });
      const trial = await prisma.subscription.count({
        where: { createdAt: { gte: start, lte: end }, status: "TRIAL" },
      });
      return { month, active, trial };
    })
  );

  const result = {
    stats: {
      totalInstitutions,
      newInstitutionsThisMonth,
      pendingInvites,
      activeStudents: 0,
      newStudentsThisWeek: 0,
      testsConducted: 0,
    },
    institutionGrowth,
    planDistribution,
    recentInstitutions,
    recentAuditLogs,
  };

  await setCache(CACHE_KEYS.overview, result, 60);
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTITUTIONS
// ─────────────────────────────────────────────────────────────────────────────

export const createInstitutionService = async (data: any) => {
  const {
    name, email, type, abbreviation, adminName, adminEmail,
    adminPhone, adminDob, adminGender,
    phone, city, state, address, pincode, country,
    board, medium, logoUrl, establishedOn,
    plan: selectedPlan = "BASIC",
    trialDays = 14,
    isDemo = false,
  } = data;

  // When creating a TRIAL institution: the subscription uses the TRIAL plan.
  // When creating a paid plan directly: no trial, subscription is ACTIVE.
  const isTrial = selectedPlan === "TRIAL";
  const activePlanName = isTrial ? "TRIAL" : selectedPlan;

  const existingInstitution = await prisma.institution.findUnique({ where: { email } });
  if (existingInstitution) throw new ConflictError("Institution with this email already exists");

  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existingAdmin) throw new ConflictError("A user with this email already exists");

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  // Generate human-readable code before the transaction (numbered per institution type).
  // The demo institute always gets 0000 and is excluded from the sequence
  // counted for every other institute of the same type.
  const institutionCode = await generateInstitutionCode(abbreviation, type, isDemo);

  const institution = await prisma.$transaction(async (tx) => {
    const newInstitution = await tx.institution.create({
      data: {
        institutionCode,
        isDemo,
        // Trial institutions are activated by default — no manual activation step.
        name, email, type, status: isTrial ? "ACTIVE" : "PENDING",
        phone, city, state, address, pincode,
        country: country ?? "India",
        board, medium, logoUrl, establishedOn,
        adminPhone, adminDob, adminGender,
        userIdPrefix: abbreviation,
      },
    });

    const adminDisplayId = await generateUserId(newInstitution.id, "A", tx);
    const adminUser = await tx.user.create({
      data: {
        name: adminName,
        email: adminEmail,
        role: "ADMIN",
        institutionId: newInstitution.id,
        isActive: false,
        displayId: adminDisplayId,
      },
    });
    await recordUserStatusEvent(tx, { userId: adminUser.id, institutionId: newInstitution.id, isActive: false });

    await tx.invite.create({
      data: {
        email: adminEmail,
        tokenHash,
        role: "ADMIN",
        institutionId: newInstitution.id,
        expiresAt,
      },
    });

    // Link the institution to the chosen plan (TRIAL or BASIC/PRO).
    const plan = await tx.plan.findFirst({ where: { name: activePlanName } });
    if (!plan) throw new NotFoundError(`Plan '${activePlanName}' not found`);

    const now = new Date();
    // Trial subscriptions are auto-activated on creation: start the clock now
    // and compute the end date from trialDays.
    const trialEndDate = isTrial
      ? new Date(now.getTime() + Number(trialDays) * 24 * 60 * 60 * 1000)
      : null;
    await tx.subscription.create({
      data: {
        institutionId: newInstitution.id,
        planId:        plan.id,
        status:        isTrial ? "TRIAL" : "ACTIVE",
        startDate:     now,
        endDate:       trialEndDate,
        trialDays:     isTrial ? Number(trialDays) : null,
        activationDate: now,
      },
    });

    return newInstitution;
  });

  const inviteLink = `${process.env.FRONTEND_URL}/set-password?token=${rawToken}`;

  // Fire-and-forget — don't let email failure block institution creation
  sendInviteEmail({ to: adminEmail, name: adminName, inviteLink, institutionCode }).catch((err) =>
    console.error("⚠️  Invite email failed (non-blocking):", err.message)
  );

  logAudit("INSTITUTION_CREATED", {
    institutionId: institution.id,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: `Created ${name} · Type: ${type}`,
    metadata: {
      institutionName: name,
      adminEmail,
      selectedPlan,
      isTrial,
      trialDays: isTrial ? Number(trialDays) : null,
    },
  });

  await delCache(CACHE_KEYS.institutions, CACHE_KEYS.overview);
  return institution;
};


export const getInstitution = async () => {
  const cached = await getCache(CACHE_KEYS.institutions);
  if (cached) return cached;

  const institutions = await prisma.institution.findMany({
    include: {
      users: {
        omit: { password: true },
        orderBy: { createdAt: "asc" },
      },
      subscription: { include: { plan: true } },
      dbConfig: { select: { mode: true, engine: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Attach role-level counts and pick the primary admin
  const result = institutions.map((inst) => {
    const admin    = inst.users.find((u) => u.role === "ADMIN") ?? null;
    const teachers = inst.users.filter((u) => (u.role as string) === "TEACHER").length;
    const students = inst.users.filter((u) => (u.role as string) === "STUDENT").length;

    return {
      ...inst,
      admin,
      teacherCount: teachers,
      studentCount: students,
    };
  });

  await setCache(CACHE_KEYS.institutions, result, 30);
  return result;
};


export const getInstitutionById = async (id: string) => {
  const institution = await prisma.institution.findUnique({
    where: { id },
    include: {
      users: { omit: { password: true } },
      subscription: {
        include: {
          plan: true,
        },
      },
    },
  });
  if (!institution) throw new NotFoundError("Institution not found");

  // Sign the admin's stored avatar path so the superadmin view can render the
  // admin's current profile photo (kept in sync with the admin's own uploads).
  let adminAvatarUrl = institution.adminAvatarUrl;
  if (adminAvatarUrl) {
    adminAvatarUrl = (await generateSignedAvatarUrl(adminAvatarUrl)) ?? adminAvatarUrl;
  }

  return { ...institution, adminAvatarUrl };
};

export const updateInstitution = async (id: string, data: any) => {
  const existing = await prisma.institution.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Institution not found");
  const result = await prisma.institution.update({ where: { id }, data });
  await delCache(CACHE_KEYS.institutions);
  return result;
};

export const updateInstitutionAdmin = async (institutionId: string, data: any) => {
  const { adminName, adminEmail, adminPhone, adminDob, adminGender, adminPrefix, adminTitle } = data;

  const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
  if (!institution) throw new NotFoundError("Institution not found");

  const adminUser = await prisma.user.findFirst({ where: { institutionId, role: "ADMIN" } });
  if (!adminUser) throw new NotFoundError("Admin user not found for this institution");

  if (adminEmail && adminEmail !== adminUser.email) {
    const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (existing) throw new ConflictError("A user with this email already exists");
  }

  const [updatedUser, updatedInstitution] = await prisma.$transaction([
    prisma.user.update({
      where: { id: adminUser.id },
      data: {
        ...(adminName !== undefined ? { name: adminName } : {}),
        ...(adminEmail !== undefined ? { email: adminEmail } : {}),
      },
    }),
    prisma.institution.update({
      where: { id: institutionId },
      data: {
        ...(adminPhone !== undefined ? { adminPhone } : {}),
        ...(adminDob !== undefined ? { adminDob } : {}),
        ...(adminGender !== undefined ? { adminGender } : {}),
        ...(adminPrefix !== undefined ? { adminPrefix } : {}),
        ...(adminTitle !== undefined ? { adminTitle } : {}),
      },
    }),
  ]);

  logAudit("INSTITUTION_ADMIN_UPDATED", {
    institutionId,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: `Admin details updated for ${institution.name}`,
  });

  await delCache(CACHE_KEYS.institutions);

  return {
    adminName: updatedUser.name,
    adminEmail: updatedUser.email,
    adminPhone: updatedInstitution.adminPhone,
    adminDob: updatedInstitution.adminDob,
    adminGender: updatedInstitution.adminGender,
    adminPrefix: updatedInstitution.adminPrefix,
    adminTitle: updatedInstitution.adminTitle,
  };
};

export const uploadInstitutionLogo = async (
  file: Buffer,
  contentType: string,
  actorId?: string
) => {
  const uploaded = await uploadImageToR2(file, {
    contentType,
    folder: "institutions/logos",
    ownerId: actorId ?? "superadmin",
  });

  logAudit("INSTITUTION_LOGO_UPLOADED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: "Institution logo uploaded",
    metadata: { path: uploaded.path, publicUrl: uploaded.publicUrl },
  });

  return { logoUrl: uploaded.publicUrl, path: uploaded.path };
};

export const toggleInstitutionStatus = async (
  id: string,
  status: "ACTIVE" | "SUSPENDED" | "PENDING",
  actorId?: string,
  actorRole?: string
) => {
  const existing = await prisma.institution.findUnique({
    where: { id },
    include: { subscription: { include: { plan: true } } },
  });
  if (!existing) throw new NotFoundError("Institution not found");

  // Reactivating must also lift any subscription-level block (LOCKED after a churn,
  // EXPIRED after auto-deactivation) — otherwise users still can't log in because the
  // login gate and access middleware block on subscription status.
  const sub = existing.subscription;
  const unlockSubscription =
    status === "ACTIVE" &&
    sub != null &&
    (sub.status === "LOCKED" || sub.status === "EXPIRED");

  const buildSubscriptionUnlock = () => {
    if (!unlockSubscription || !sub) return null;
    if (sub.plan.name === "TRIAL") {
      // Restore trial access WITHOUT resetting the countdown — reactivation only
      // lifts the block; the original startDate/endDate stay untouched so the trial
      // continues from where it left off.
      return prisma.subscription.update({
        where: { institutionId: id },
        data: { status: "TRIAL", trialOutcome: null },
      });
    }
    // Paid plans return to ACTIVE; clear the churned outcome.
    return prisma.subscription.update({
      where: { institutionId: id },
      data: { status: "ACTIVE", trialOutcome: null },
    });
  };

  const subscriptionUnlock = buildSubscriptionUnlock();
  const [result] = await prisma.$transaction([
    prisma.institution.update({ where: { id }, data: { status } }),
    ...(subscriptionUnlock ? [subscriptionUnlock] : []),
  ]);
  // Invalidate the access-gate cache so suspension/reactivation takes effect immediately.
  await delCache(CACHE_KEYS.institutions, CACHE_KEYS.overview, `inst:access:${id}`);

  const action = status === "ACTIVE"
    ? "INSTITUTION_ACTIVATED"
    : status === "SUSPENDED"
    ? "INSTITUTION_SUSPENDED"
    : "INSTITUTION_STATUS_CHANGED";

  logAudit(action, {
    userId: actorId,
    actorRole,
    institutionId: id,
    category: "SUPERADMIN_ACTION",
    severity: "WARNING",
    details: `${existing.name} status changed to ${status}`,
    metadata: { newStatus: status },
  });

  return result;
};

export const activateTrial = async (id: string, actorId?: string) => {
  const institution = await prisma.institution.findUnique({
    where: { id },
    include: { subscription: true },
  });
  if (!institution) throw new NotFoundError("Institution not found");
  const subscription = institution.subscription;
  if (!subscription || subscription.status !== "TRIAL") {
    throw new BadRequestError("Institution is not on a trial plan.");
  }
  if (subscription.startDate) {
    throw new BadRequestError("Trial has already been activated.");
  }

  const now = new Date();
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + (subscription.trialDays ?? 14));

  await prisma.$transaction([
    prisma.subscription.update({
      where: { institutionId: id },
      data: { startDate: now, endDate },
    }),
    prisma.institution.update({
      where: { id },
      data: { status: "ACTIVE" },
    }),
  ]);

  await delCache(CACHE_KEYS.institutions, CACHE_KEYS.overview, `inst:access:${id}`);

  logAudit("TRIAL_ACTIVATED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId: id,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: `Trial activated for ${institution.name}`,
    metadata: { trialDays: subscription.trialDays, startDate: now, endDate },
  });

  return { startDate: now.toISOString(), endDate: endDate.toISOString(), trialDays: subscription.trialDays };
};

export const extendTrial = async (id: string, extraDays: number, actorId?: string) => {
  const subscription = await prisma.subscription.findUnique({ where: { institutionId: id } });
  if (!subscription || subscription.status !== "TRIAL") {
    throw new BadRequestError("Institution is not on a trial plan.");
  }
  if (!subscription.startDate) {
    throw new BadRequestError("Trial has not been activated yet.");
  }

  const currentEnd = subscription.endDate ? new Date(subscription.endDate) : new Date();
  const newEnd = new Date(currentEnd);
  newEnd.setDate(newEnd.getDate() + extraDays);
  
  const result = await prisma.subscription.update({
    where: { institutionId: id },
    data: {
      endDate: newEnd,
      trialDays: { increment: extraDays },
      trialOutcome: "EXTENDED",
      trialWarningSent: false,
      trialExpiryNotified: false,
    }
  });
  
  await delCache(CACHE_KEYS.institutions, CACHE_KEYS.overview);

  logAudit("TRIAL_EXTENDED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId: id,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: `Trial extended by ${extraDays} days`,
    metadata: { extraDays, newEnd },
  });

  return result;
};

export const markTrialChurned = async (id: string, actorId?: string) => {
  const subscription = await prisma.subscription.findUnique({ where: { institutionId: id } });
  if (!subscription || subscription.status !== "TRIAL") {
    throw new BadRequestError("Institution is not on an active trial.");
  }

  // Update trialOutcome and lock the institution
  const result = await prisma.$transaction([
    prisma.subscription.update({
      where: { institutionId: id },
      data: { trialOutcome: "CHURNED", status: "LOCKED" }
    }),
    prisma.institution.update({
      where: { id },
      data: { status: "SUSPENDED" }
    })
  ]);

  await delCache(CACHE_KEYS.institutions, CACHE_KEYS.overview);

  logAudit("TRIAL_CHURNED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId: id,
    category: "SUPERADMIN_ACTION",
    severity: "WARNING",
    details: `Institution marked as churned after trial`,
  });

  return result[0];
};

export const getTrialUsage = async (id: string) => {
  const institution = await prisma.institution.findUnique({
    where: { id },
    include: {
      _count: { select: { users: true } },
      subscription: true,
    },
  });
  if (!institution) throw new NotFoundError("Institution not found");

  const sub = institution.subscription;
  const now = new Date();
  const trialDays = sub?.trialDays ?? 14;

  // Prefer the stored endDate, but fall back to (trial start + trialDays) for trials
  // created before the end date was persisted. Trials are auto-activated at creation,
  // so the institution's createdAt is the ultimate fallback for the start of the trial.
  const trialStart = sub?.startDate ?? sub?.activationDate ?? institution.createdAt;
  const endDate = sub?.endDate
    ? new Date(sub.endDate)
    : new Date(new Date(trialStart).getTime() + trialDays * 24 * 60 * 60 * 1000);

  const daysRemaining = endDate
    ? Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
    : null;

  const [storageGbUsed, aiTokensUsed] = await Promise.all([
    bytesToGb(await getInstitutionStorageBytes(id)),
    getAiTokensUsed(id),
  ]);

  return {
    users:      { used: institution._count.users, limit: 500 },
    storageGb:  { used: storageGbUsed,            limit: 10 },
    aiTokens:   { used: aiTokensUsed,             limit: PLAN_AI_TOKENS.TRIAL },
    daysRemaining,
    trialEndDate: endDate?.toISOString() ?? null,
    status: sub?.status ?? null,
  };
};

export const checkTrialUserLimit = async (institutionId: string) => {
  const subscription = await prisma.subscription.findUnique({
    where: { institutionId },
    select: { status: true },
  });
  if (!subscription || subscription.status !== "TRIAL") return;

  const userCount = await prisma.user.count({ where: { institutionId } });
  if (userCount >= 500) {
    throw new TooManyRequestsError(
      "Trial user limit reached. Maximum 500 users allowed during trial."
    );
  }
};

export const deleteInstitution = async (id: string, actorId?: string) => {
  const institution = await prisma.institution.findUnique({ where: { id } });
  if (!institution) throw new NotFoundError("Institution not found");

  // Collect institution user IDs before deletion
  const institutionUsers = await prisma.user.findMany({
    where: { institutionId: id },
    select: { id: true },
  });
  const userIds = institutionUsers.map((u) => u.id);

  // Academic rows may live in the institution's own database (BYOD); platform
  // rows are always central. A transaction cannot span two databases, so the
  // deletes are grouped by tenancy. For managed institutions the academic
  // client IS the central client, so both groups run in one atomic transaction.
  // For BYOD they run as two transactions — academic (tenant DB) then platform
  // (central) — which is safe because there are no cross-database foreign keys.
  const academicClient = await getAcademicClient(id);

  // Academic deletes, in dependency order (children before parents).
  const academicDeletes = (c: AcademicClient) => [
    c.staffPostReaction.deleteMany({ where: { institutionId: id } }),
    c.staffPostComment.deleteMany({ where: { institutionId: id } }),
    c.studentPromotionOutcome.deleteMany({ where: { institutionId: id } }),
    c.staffPost.deleteMany({ where: { institutionId: id } }),
    c.staffMessage.deleteMany({ where: { institutionId: id } }),
    c.campusFeedPost.deleteMany({ where: { institutionId: id } }),
    c.calendarEvent.deleteMany({ where: { institutionId: id } }),
    c.attendance.deleteMany({ where: { institutionId: id } }),
    c.schoolHoliday.deleteMany({ where: { institutionId: id } }),
    c.attendanceDayNote.deleteMany({ where: { institutionId: id } }),
    c.studentRemark.deleteMany({ where: { institutionId: id } }),
    c.studentFeePayment.deleteMany({ where: { institutionId: id } }),
    c.divisionFeeStructure.deleteMany({ where: { institutionId: id } }),
    c.blackboardMaterial.deleteMany({ where: { institutionId: id } }),
    c.taskPdfUpload.deleteMany({ where: { institutionId: id } }),
    c.questionShareToken.deleteMany({ where: { institutionId: id } }),
    // Cascades: TaskTestQuestion, TaskTestAttempt, TaskStudentAnswer
    c.taskTest.deleteMany({ where: { institutionId: id } }),
    // Cascades: TaskModuleQuestion
    c.taskModule.deleteMany({ where: { institutionId: id } }),
    // Cascades: TaskAssignmentSubmission
    c.taskAssignment.deleteMany({ where: { institutionId: id } }),
    // Cascades: TaskQuestion (already stripped of test/module/assignment refs above)
    c.taskContainer.deleteMany({ where: { institutionId: id } }),
    // Cascades: MarksheetSubjectConfig, MarksheetExamColumn, MarksheetScore,
    // MarksheetGradedSubject, MarksheetGradedScore
    c.marksheet.deleteMany({ where: { institutionId: id } }),
    c.teacherNote.deleteMany({ where: { institutionId: id } }),
    c.teacherTask.deleteMany({ where: { institutionId: id } }),
    c.divisionAssignment.deleteMany({ where: { institutionId: id } }),
    c.divisionSubject.deleteMany({ where: { institutionId: id } }),
    // Promotion batches, blackboard folders (self-referential) now safe.
    c.promotionBatch.deleteMany({ where: { institutionId: id } }),
    c.blackboardFolder.deleteMany({ where: { institutionId: id } }),
    // Campus structure — Division before Standard/Subject, both before Student.
    c.division.deleteMany({ where: { institutionId: id } }),
    c.subject.deleteMany({ where: { institutionId: id } }),
    c.student.deleteMany({ where: { institutionId: id } }),
    c.standard.deleteMany({ where: { institutionId: id } }),
    // Teacher after everything above that references it.
    c.teacher.deleteMany({ where: { institutionId: id } }),
  ];

  // Platform deletes, in dependency order (always central).
  const platformDeletes = [
    prisma.ticketReply.deleteMany({ where: { ticket: { institutionId: id } } }),
    prisma.notificationRecipient.deleteMany({ where: { institutionId: id } }),
    prisma.supportTicket.deleteMany({ where: { institutionId: id } }),
    prisma.review.deleteMany({ where: { institutionId: id } }),
    prisma.invite.deleteMany({ where: { institutionId: id } }),
    prisma.bill.deleteMany({ where: { institutionId: id } }),
    prisma.subscription.deleteMany({ where: { institutionId: id } }),
    prisma.subAdmin.deleteMany({ where: { institutionId: id } }),
    prisma.auditLog.deleteMany({ where: { institutionId: id } }),
    // Nullify audit log entries referencing institution users that aren't
    // scoped to this institution (e.g. superadmin-level logs) — safety net.
    ...(userIds.length > 0
      ? [prisma.auditLog.updateMany({ where: { userId: { in: userIds } }, data: { userId: null } })]
      : []),
    // Status events reference users — must go before the users are removed.
    prisma.userStatusEvent.deleteMany({ where: { institutionId: id } }),
    // Users last (Teacher/Student/SubAdmin no longer reference them).
    prisma.user.deleteMany({ where: { institutionId: id } }),
    prisma.institution.delete({ where: { id } }),
  ];

  if (academicClient === prisma) {
    // Managed: single atomic transaction, academic children before platform parents.
    await prisma.$transaction([...academicDeletes(prisma), ...platformDeletes]);
  } else {
    // BYOD: academic rows live in the tenant DB — separate transaction, then platform.
    await academicClient.$transaction(academicDeletes(academicClient));
    await prisma.$transaction(platformDeletes);
  }

  await delCache(CACHE_KEYS.institutions, CACHE_KEYS.overview);

  // Log the deletion by the superadmin (survives — not tied to the institution)
  logAudit("INSTITUTION_DELETED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    category: "SUPERADMIN_ACTION",
    severity: "CRITICAL",
    details: `Institution "${institution.name}" (${institution.institutionCode}) permanently deleted along with ${userIds.length} user(s)`,
    metadata: { institutionId: id, name: institution.name, usersDeleted: userIds.length },
  });
};

export const resendInvite = async (email: string, institutionId: string) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new NotFoundError("User not found");

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await prisma.invite.create({
    data: { email, tokenHash, role: "ADMIN", institutionId: user.institutionId!, expiresAt },
  });

  const inviteLink = `${process.env.FRONTEND_URL}/set-password?token=${rawToken}`;
  sendInviteEmail({ to: user.email, inviteLink }).catch((err) =>
    console.error("⚠️  Resend invite email failed:", err.message)
  );

  logAudit("INVITE_SENT", {
    institutionId,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: `Invite resent to ${email}`,
    metadata: { email },
  });

  return { message: "Invite resent successfully" };
};

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────

export const getAuditLogs = async (query: {
  action?: string;
  institutionId?: string;
  actorRole?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}) => {
  const { action, institutionId, actorRole, from, to, page = 1, limit = 20 } = query;
  const skip = (page - 1) * limit;

  const where: any = {};
  if (action)        where.action        = { contains: action, mode: "insensitive" };
  if (institutionId) where.institutionId = institutionId;
  if (actorRole)     where.actorRole     = actorRole;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to)   where.createdAt.lte = new Date(to);
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        user:        { select: { id: true, name: true, email: true } },
        institution: { select: { id: true, name: true, institutionCode: true } },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    logs,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// PLAN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

async function getAiTokensUsed(institutionId: string): Promise<number> {
  if (!redis || !isRedisReady) return 0;
  try {
    const used = await redis.get(`ai:usage:institution:${institutionId}`);
    return Number(used ?? 0) || 0;
  } catch {
    return 0;
  }
}

async function computeUsageMeters(institutionId: string, planName: string, addons: unknown, storageGbUsed = 0) {
  const baseTokens = PLAN_AI_TOKENS[planName as keyof typeof PLAN_AI_TOKENS] ?? PLAN_AI_TOKENS.BASIC;
  const normalizedAddons = (addons && typeof addons === "object" && !Array.isArray(addons))
    ? addons as Record<string, unknown>
    : {};

  const extraTokens = (normalizedAddons.extraAiTokens as Array<{ active?: boolean; tokensPerMonth?: number }> ?? [])
    .filter((t) => t.active)
    .reduce((sum, t) => sum + (t.tokensPerMonth ?? 0), 0);

  const extraStorageGb = (normalizedAddons.extraStorage as Array<{ active?: boolean; gbPurchased?: number }> ?? [])
    .filter((s) => s.active)
    .reduce((sum, s) => sum + (s.gbPurchased ?? 0), 0);

  const basePlanStorageGb = planName === "PRO" ? 1024 : 500;
  const tokensUsed = await getAiTokensUsed(institutionId);

  return {
    aiTokens: { used: tokensUsed, total: baseTokens + extraTokens },
    storageGb: { used: storageGbUsed, total: basePlanStorageGb + extraStorageGb },
  };
}

export const getPlans = async () => {
  return prisma.plan.findMany({ orderBy: { basePrice: "asc" } });
};

export const getInstitutionUsers = async (id: string, year: number, month: number) => {
  const institution = await prisma.institution.findUnique({ where: { id }, select: { id: true } });
  if (!institution) throw new NotFoundError("Institution not found");
  return getInstitutionUsersForMonth(id, year, month);
};

export const getInstitutionPlan = async (id: string) => {
  const institution = await prisma.institution.findUnique({
    where: { id },
    include: { subscription: { include: { plan: true } } },
  });
  if (!institution) throw new NotFoundError("Institution not found");
  return institution.subscription;
};

export const getInstitutionPlanDashboard = async (id: string) => {
  const institution = await prisma.institution.findUnique({
    where: { id },
    include: {
      users: { select: { role: true } },
      subscription: { include: { plan: true } },
    },
  });
  if (!institution) throw new NotFoundError("Institution not found");
  if (!institution.subscription) throw new NotFoundError("Subscription not found");

  const [latestBill] = await prisma.bill.findMany({
    where: { institutionId: id },
    orderBy: { generatedAt: "desc" },
    take: 1,
  });

  const adminCount = institution.users.filter((u) => u.role === "ADMIN").length;
  const teacherCount = 0;
  const studentCount = 0;
  const activationDate = institution.subscription.activationDate;
  const nextBillingDate = activationDate ? getNextBillingDate(activationDate) : null;

  return {
    userBreakdown: {
      admin: adminCount,
      teachers: teacherCount,
      students: studentCount,
      total: adminCount + teacherCount + studentCount,
    },
    planDetails: {
      planName: institution.subscription.plan.name,
      activationDate,
      nextBillingDate,
      status: institution.subscription.status,
    },
    billingStatus: latestBill
      ? {
          currentMonthBillId: latestBill.id,
          amount: latestBill.totalAmount,
          status: latestBill.status,
          dueDate: latestBill.dueDate,
          generatedAt: latestBill.generatedAt,
        }
      : null,
    addonStatus: (institution.subscription.addons ?? {}) as Record<string, unknown>,
    usageMeters: await computeUsageMeters(
      id,
      institution.subscription.plan.name,
      institution.subscription.addons,
      bytesToGb(await getInstitutionStorageBytes(id)),
    ),
  };
};

export const updateInstitutionPlan = async (
  id: string,
  data: { planName: string; discount: number; paymentStatus: "PAID" | "PENDING" | "FAILED" },
  actorId?: string,
  actorRole?: string
) => {
  const institution = await prisma.institution.findUnique({ where: { id } });
  if (!institution) throw new NotFoundError("Institution not found");

  const plan = await prisma.plan.findFirst({ where: { name: data.planName } });
  if (!plan) throw new NotFoundError(`Plan '${data.planName}' not found`);

  const subscription = await prisma.subscription.upsert({
    where: { institutionId: id },
    update: {
      planId: plan.id,
      discount: data.discount,
      paymentStatus: data.paymentStatus,
      status: "ACTIVE",
    },
    create: {
      institutionId: id,
      planId: plan.id,
      discount: data.discount,
      paymentStatus: data.paymentStatus,
      status: "ACTIVE",
      startDate: new Date(),
    },
  });

  logAudit("PLAN_ASSIGNED", {
    userId: actorId,
    actorRole,
    institutionId: id,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: `${institution.name} assigned to ${data.planName} plan with ${data.discount}% discount`,
    metadata: { plan: data.planName, discount: data.discount, paymentStatus: data.paymentStatus },
  });

  return subscription;
};

export const activateInstitutionPlan = async (
  id: string,
  planName: PlanName,
  discountPct: number,
  paymentReceived: boolean,
  actorId?: string
) => {
  const institution = await prisma.institution.findUnique({
    where: { id },
    include: {
      users: { where: { role: "ADMIN" }, omit: { password: true } },
      subscription: true,
    },
  });
  if (!institution) throw new NotFoundError("Institution not found");
  if (!institution.subscription) throw new NotFoundError("No subscription found for this institution");

  const plan = await prisma.plan.findFirst({ where: { name: planName } });
  if (!plan) throw new NotFoundError(`Plan '${planName}' not found`);

  if (!paymentReceived) {
    throw new BadRequestError("License payment must be marked as received to activate plan");
  }

  const activationDate = new Date();
  const existingAddons = (institution.subscription.addons ?? {}) as Record<string, unknown>;
  const smartBoardAddon = buildSmartBoardFreeAddon(activationDate);
  const features = getFeatureFlagsForPlan(planName);

  const subscription = await prisma.subscription.update({
    where: { institutionId: id },
    data: {
      planId: plan.id,
      status: "ACTIVE",
      paymentStatus: "PAID",
      discount: discountPct,
      activationDate,
      trialOutcome: "ACTIVATED",
      endDate: null,
      features,
      addons: {
        ...existingAddons,
        [FIRST_YEAR_FREE_ADDON_KEY]: smartBoardAddon,
      },
    },
    include: { plan: true },
  });

  // Ensure institution status is ACTIVE
  await prisma.institution.update({ where: { id }, data: { status: "ACTIVE" } });

  // Generate licence bill
  const licenceFee = plan.basePrice;
  const discountAmount = Math.round(licenceFee * (discountPct / 100));
  const invoice = await generateLicenceBill({
    institutionId: id,
    planName,
    licenceAmount: licenceFee,
    discountPct,
    discountAmount,
    activationDate,
    institutionName: institution.name,
  });

  // Email the institution admin
  const adminUser = institution.users[0];
  if (adminUser?.email) {
    const now = new Date();
    const nextBillingDate = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day of current month
    sendActivationEmail({
      to: adminUser.email,
      institutionName: institution.name,
      planName,
      activationDate,
      nextBillingDate,
      discountPct,
      invoiceId: invoice.id,
      invoiceAmount: invoice.totalAmount,
      licenseFee: licenceFee,
      discountAmount,
    }).catch((err) => console.error("Activation email failed:", err.message));
  }

  await delCache(CACHE_KEYS.institutions, CACHE_KEYS.overview);

  logAudit("PLAN_ACTIVATED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId: id,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: `${institution.name} activated on ${planName} plan${discountPct > 0 ? ` with ${discountPct}% discount` : ""}`,
    metadata: {
      plan: planName,
      discountPct,
      activationDate,
      paymentReceived,
      smartBoardFreeUntil: smartBoardAddon.freeEndDate,
    },
  });

  return subscription;
};

export const updateInstitutionFeatures = async (
  id: string,
  features: Record<string, boolean>
) => {
  const existing = await prisma.institution.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Institution not found");

  const subscription = await prisma.subscription.findUnique({ where: { institutionId: id } });
  if (!subscription) throw new NotFoundError("No subscription found for this institution");

  return prisma.subscription.update({
    where: { institutionId: id },
    data: { features },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const broadcastNotification = async (
  data: {
    title: string;
    message: string;
    tag: string;
    recipient: string;
    institutionIds?: string[];
  },
  actorId?: string
) => {
  // Determine target institution IDs
  let targetInstitutions: { id: string }[] = [];

  if (data.recipient === "ALL") {
    targetInstitutions = await prisma.institution.findMany({ select: { id: true } });
  } else if (data.recipient === "SPECIFIC") {
    targetInstitutions = (data.institutionIds ?? []).map((id) => ({ id }));
  } else {
    targetInstitutions = await prisma.institution.findMany({
      where: { type: data.recipient as any },
      select: { id: true },
    });
  }

  const notification = await prisma.notification.create({
    data: {
      title: data.title,
      message: data.message,
      tag: data.tag,
      recipientType: data.recipient,
      deliveredTo: targetInstitutions.length,
      sentById: actorId,
      recipients: {
        create: targetInstitutions.map((inst) => ({ institutionId: inst.id })),
      },
    },
  });

  logAudit("NOTIFICATION_SENT", {
    userId: actorId,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: `Broadcast: "${data.title}" → ${targetInstitutions.length} institutions`,
    metadata: { tag: data.tag, recipient: data.recipient },
  });

  return notification;
};

export const getNotifications = async (page = 1, limit = 20) => {
  const skip = (page - 1) * limit;
  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.notification.count(),
  ]);
  return { notifications, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
};

// Superadmin bell feed: notifications only for things admins do that need attention —
// new support tickets ("reported something") and new reviews. Merged newest-first.
export const getSuperadminNotificationFeed = async (limit = 20) => {
  const [tickets, reviews] = await Promise.all([
    prisma.supportTicket.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { institution: { select: { name: true } } },
    }),
    prisma.review.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { institution: { select: { name: true } } },
    }),
  ]);

  const ticketItems = tickets.map((t) => ({
    id: `ticket-${t.id}`,
    title: `New support ticket: ${t.title}`,
    message: `${t.institution.name} (${t.adminEmail}): ${t.description}`,
    tag: "NEW_TICKET",
    createdAt: t.createdAt,
  }));

  const reviewItems = reviews.map((r) => ({
    id: `review-${r.id}`,
    title: `New review · ${r.rating}★ — ${r.title}`,
    message: `${r.institution.name} (${r.adminName}): ${r.body}`,
    tag: "NEW_REVIEW",
    createdAt: r.createdAt,
  }));

  const notifications = [...ticketItems, ...reviewItems]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);

  return { notifications };
};

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT TICKETS
// ─────────────────────────────────────────────────────────────────────────────

export const getTickets = async (query: {
  status?: string;
  category?: string;
  search?: string;
  page?: number;
  limit?: number;
}) => {
  const { status, category, search, page = 1, limit = 20 } = query;
  const skip = (page - 1) * limit;

  const where: any = {};
  if (status)   where.status   = status;
  if (category) where.category = category;
  if (search) {
    where.OR = [
      { title:      { contains: search, mode: "insensitive" } },
      { adminEmail: { contains: search, mode: "insensitive" } },
      { institution: { name: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        institution: { select: { name: true, type: true, adminAvatarUrl: true } },
        replies: { orderBy: { createdAt: "asc" } },
      },
    }),
    prisma.supportTicket.count({ where }),
  ]);

  // Sign each institution admin's avatar so ADMIN replies can render their photo.
  const ticketsWithAvatar = await Promise.all(
    tickets.map(async (t) => {
      let adminAvatarUrl = t.institution.adminAvatarUrl ?? null;
      if (adminAvatarUrl) {
        adminAvatarUrl = (await generateSignedAvatarUrl(adminAvatarUrl)) ?? adminAvatarUrl;
      }
      return { ...t, adminAvatarUrl };
    })
  );

  return { tickets: ticketsWithAvatar, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
};

export const getTicketById = async (id: string) => {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id },
    include: {
      institution: { select: { name: true, type: true } },
      replies: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!ticket) throw new NotFoundError("Ticket not found");
  return ticket;
};

export const updateTicketStatus = async (id: string, status: string) => {
  const existing = await prisma.supportTicket.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Ticket not found");
  return prisma.supportTicket.update({ where: { id }, data: { status } });
};

export const uploadTicketReplyAttachment = async (
  ticketId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number }
) => {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { institutionId: true } });
  if (!ticket) throw new NotFoundError("Ticket not found");

  const result = await uploadAttachmentToR2(file.buffer, {
    originalName: file.originalname,
    contentType: file.mimetype,
    institutionId: ticket.institutionId,
    area: "support/tickets",
  });

  return { url: result.publicUrl, name: file.originalname, type: result.attachmentType, size: file.size };
};

export const replyToTicket = async (
  id: string,
  message: string,
  attachments?: { url: string; name: string; type: string; size: number }[]
) => {
  const existing = await prisma.supportTicket.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Ticket not found");

  const reply = await prisma.ticketReply.create({
    data: { ticketId: id, author: "Super Admin", role: "SUPER_ADMIN", message, attachments: attachments ?? undefined },
  });

  if (existing.status === "OPEN") {
    await prisma.supportTicket.update({ where: { id }, data: { status: "IN_PROGRESS" } });
  }

  // Notify the institution's admin
  const truncated = message.length > 160 ? message.slice(0, 160) + "…" : message;
  await prisma.notification.create({
    data: {
      title: "QubeEx Support replied to your ticket",
      message: `${existing.title} — ${truncated}`,
      tag: "TICKET_REPLY",
      recipientType: "SPECIFIC",
      deliveredTo: 1,
      recipients: {
        create: [{ institutionId: existing.institutionId }],
      },
    },
  });

  return reply;
};

// ─────────────────────────────────────────────────────────────────────────────
// REVIEWS
// ─────────────────────────────────────────────────────────────────────────────

export const getReviews = async (query: {
  type?: string;
  rating?: number;
  search?: string;
  page?: number;
  limit?: number;
}) => {
  const { type, rating, search, page = 1, limit = 20 } = query;
  const skip = (page - 1) * limit;

  const where: any = {};
  if (rating) where.rating = rating;
  if (type)   where.institution = { type };
  if (search) {
    where.OR = [
      { title:     { contains: search, mode: "insensitive" } },
      { body:      { contains: search, mode: "insensitive" } },
      { adminName: { contains: search, mode: "insensitive" } },
      { institution: { name: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [reviews, total] = await Promise.all([
    prisma.review.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { institution: { select: { name: true, type: true } } },
    }),
    prisma.review.count({ where }),
  ]);

  return { reviews, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
};

export const replyToReview = async (id: string, message: string) => {
  const existing = await prisma.review.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Review not found");
  if (existing.replyMessage) throw new ConflictError("This review already has a reply");

  return prisma.review.update({
    where: { id },
    data: { replyMessage: message, repliedAt: new Date() },
  });
};

export const likeReview = async (id: string) => {
  const existing = await prisma.review.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Review not found");

  const updated = await prisma.review.update({
    where: { id },
    data: { likes: { increment: 1 } },
  });
  return { likes: updated.likes };
};

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM HEALTH
// ─────────────────────────────────────────────────────────────────────────────

export const getSystemHealth = async () => {
  // Live DB check
  let dbStatus = "operational";
  let dbLatency = 0;
  try {
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatency = Date.now() - start;
  } catch {
    dbStatus = "down";
  }

  const services = [
    { name: "API Server",     status: "operational", uptime: "99.98%", latency: "—",           region: "Mumbai" },
    { name: "Database",       status: dbStatus,       uptime: "99.99%", latency: `${dbLatency}ms`, region: "Mumbai" },
    { name: "Queue (Redis)",  status: "operational", uptime: "99.85%", latency: "—",           region: "Mumbai" },
    { name: "Storage (S3)",   status: "operational", uptime: "99.95%", latency: "—",           region: "Global" },
    { name: "AI (Claude)",    status: "operational", uptime: "99.90%", latency: "—",           region: "Global" },
    { name: "Email (Resend)", status: "operational", uptime: "99.85%", latency: "—",           region: "Global" },
  ];

  // Recent errors from audit logs
  const recentErrors = await prisma.auditLog.findMany({
    where: { action: { in: ["LOGIN_FAILED", "INVITE_SENT"] } },
    take: 5,
    orderBy: { createdAt: "desc" },
  });

  return {
    services,
    queues: [
      { name: "Email Queue",       pending: 0, processing: 0, failed: 0, color: "#7C3AED" },
      { name: "Test Evaluation",   pending: 0, processing: 0, failed: 0, color: "#F59E0B" },
      { name: "Report Generation", pending: 0, processing: 0, failed: 0, color: "#10B981" },
      { name: "AI Processing",     pending: 0, processing: 0, failed: 0, color: "#2563EB" },
    ],
    recentErrors,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// AI USAGE
// ─────────────────────────────────────────────────────────────────────────────

export const getAIUsage = async (range: string) => {
  const summary = await getPlatformUsageSummary(range);
  return {
    summary: {
      totalTokens: summary.totalTokens,
      totalRequests: summary.totalRequests,
      successRequests: summary.successRequests,
      failedRequests: summary.failedRequests,
    },
    trend: summary.trend,
    byFeature: summary.byFeature,
    perInstitution: summary.byInstitution,
  };
};

export const getInstitutionAiUsage = async (institutionId: string, range: string) => {
  const institution = await prisma.institution.findUnique({ where: { id: institutionId }, select: { id: true } });
  if (!institution) throw new NotFoundError("Institution not found");
  return getInstitutionUsageSummary(institutionId, range);
};

// ─────────────────────────────────────────────────────────────────────────────
// VAULT
// ─────────────────────────────────────────────────────────────────────────────

export const getVaultStats = async () => {
  const activeSubscriptions = await prisma.subscription.findMany({
    where: { status: "ACTIVE" },
    include: { plan: true },
  });

  const mrr = activeSubscriptions.reduce((sum, sub) => {
    const monthly = (sub.plan.basePrice * (1 - sub.discount / 100)) / 12;
    return sum + monthly;
  }, 0);

  return {
    mrr: Math.round(mrr),
    arr: Math.round(mrr * 12),
    activeSubscriptions: activeSubscriptions.length,
    churnRate: 0,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// BILLING
// ─────────────────────────────────────────────────────────────────────────────

export const getBills = async (id: string, page: number, limit: number) => {
  const [bills, total] = await Promise.all([
    prisma.bill.findMany({
      where: { institutionId: id },
      orderBy: { generatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.bill.count({ where: { institutionId: id } }),
  ]);
  return { bills, total, page, limit, pages: Math.ceil(total / limit) };
};

export const updateBillStatus = async (
  billId: string,
  status: "PAID" | "PENDING",
  actorId?: string,
  paymentMethod?: string
) => {
  const bill = await prisma.bill.findUnique({
    where: { id: billId },
    select: { id: true, institutionId: true, razorpayLinkId: true },
  });
  if (!bill) throw new NotFoundError("Bill not found");

  if (status === "PAID") {
    const { reactivated } = await markBillPaid(billId, undefined, paymentMethod);

    // Cancel the Razorpay link so it can't be double-paid
    if (bill.razorpayLinkId) {
      cancelPaymentLink(bill.razorpayLinkId).catch((err: Error) =>
        console.warn("[Billing] cancel link failed:", err.message)
      );
    }

    logAudit("BILL_STATUS_UPDATED", {
      userId: actorId,
      actorRole: "SUPER_ADMIN",
      institutionId: bill.institutionId,
      category: "BILLING",
      severity: "INFO",
      details: `Bill ${billId} manually marked PAID by superadmin`,
      metadata: { billId, status, reactivated },
    });

    const updatedBill = await prisma.bill.findUnique({ where: { id: billId } });
    return { bill: updatedBill!, reactivated };
  }

  // status === "PENDING" — just reset the bill
  const updated = await prisma.bill.update({
    where: { id: billId },
    data: { status: "PENDING", paidAt: null, razorpayPaymentId: null },
  });

  logAudit("BILL_STATUS_UPDATED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId: bill.institutionId,
    category: "BILLING",
    severity: "INFO",
    details: `Bill ${billId} reset to PENDING by superadmin`,
    metadata: { billId, status, reactivated: false },
  });

  return { bill: updated, reactivated: false };
};

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM PAYMENT SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

export const getPaymentSettings = async () => {
  return prisma.platformSettings.findUnique({ where: { id: "platform" } });
};

export const updatePaymentSettings = async (
  data: {
    bankAccountName?: string;
    bankAccountNumber?: string;
    bankIfsc?: string;
    bankName?: string;
    upiId?: string;
  },
  actorId?: string
) => {
  const settings = await prisma.platformSettings.upsert({
    where: { id: "platform" },
    create: { id: "platform", ...data, updatedBy: actorId },
    update: { ...data, updatedBy: actorId },
  });

  logAudit("PLATFORM_PAYMENT_SETTINGS_UPDATED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    category: "BILLING",
    severity: "INFO",
    details: "Platform payment settings updated by superadmin",
  });

  return settings;
};

export const generateLicenceBill = async (data: {
  institutionId: string;
  planName: PlanName;
  licenceAmount: number;
  discountPct: number;
  discountAmount: number;
  activationDate: Date;
  institutionName: string;
}) => {
  const {
    institutionId,
    planName,
    licenceAmount,
    discountPct,
    discountAmount,
    activationDate,
    institutionName,
  } = data;
  const totalAmount = licenceAmount - discountAmount;
  const now = new Date();
  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + 7);
  const billingAnchor = getNextBillingDate(activationDate);

  return prisma.bill.create({
    data: {
      institutionId,
      type: "LICENCE",
      totalAmount,
      baseAmount: licenceAmount,
      discountAmount,
      items: [
        {
          label: "Licence Fee",
          desc: `One-time ${planName} licence for ${institutionName}`,
          amount: licenceAmount,
          type: "licence",
        },
        ...(discountAmount > 0
          ? [
              {
                label: "Discount",
                desc: `${discountPct}% discount applied on licence fee`,
                amount: -discountAmount,
                type: "discount",
              },
            ]
          : []),
        {
          label: "Billing Anchor",
          desc: `Per-user billing anchor date: ${billingAnchor.toISOString()}`,
          amount: 0,
          type: "metadata",
        },
        {
          label: "Plan Activation Date",
          desc: activationDate.toISOString(),
          amount: 0,
          type: "metadata",
        },
      ],
      dueDate,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// ADDONS
// ─────────────────────────────────────────────────────────────────────────────

type AddonUpdate = {
  smartBoardAi?: Record<string, unknown>;
  performanceInsightsAndAnalytics?: Record<string, unknown>;
  timetableAutoScheduling?: Record<string, unknown>;
  aiTokenAddon?: { active: false } | { active: true; tokensPerMonth: number; pricePerMillion: number };
  extraStorage?: { gbPurchased: number; price: number }[];
};

export const updateAddons = async (id: string, incoming: AddonUpdate, actorId?: string) => {
  const sub = await prisma.subscription.findUnique({
    where: { institutionId: id },
    include: { institution: true },
  });
  if (!sub) throw new NotFoundError("Subscription not found");

  const existing = (sub.addons && typeof sub.addons === "object" && !Array.isArray(sub.addons))
    ? (sub.addons as Record<string, unknown>)
    : {};

  const merged: Record<string, unknown> = { ...existing };

  if (incoming.smartBoardAi !== undefined)
    merged.smartBoardAi = incoming.smartBoardAi;
  if (incoming.performanceInsightsAndAnalytics !== undefined)
    merged.performanceInsightsAndAnalytics = incoming.performanceInsightsAndAnalytics;
  if (incoming.timetableAutoScheduling !== undefined)
    merged.timetableAutoScheduling = incoming.timetableAutoScheduling;

  if (incoming.aiTokenAddon !== undefined) {
    if (!incoming.aiTokenAddon.active) {
      merged.extraAiTokens = [];
    } else {
      const { tokensPerMonth, pricePerMillion } = incoming.aiTokenAddon;
      const monthlyAmount = Math.round((tokensPerMonth / 1_000_000) * pricePerMillion);
      merged.extraAiTokens = [{ active: true, tokensPerMonth, monthlyAmount }];
    }
  }

  if (incoming.extraStorage && incoming.extraStorage.length > 0) {
    const existingStorage = Array.isArray(existing.extraStorage)
      ? (existing.extraStorage as unknown[])
      : [];
    const newEntries = incoming.extraStorage.map((s) => ({
      active: true,
      gbPurchased: s.gbPurchased,
      oneTimeAmount: s.price,
      purchasedAt: new Date().toISOString(),
    }));
    merged.extraStorage = [...existingStorage, ...newEntries];
  }

  const updated = await prisma.subscription.update({
    where: { institutionId: id },
    data: { addons: merged as any },
  });

  logAudit("ADDONS_UPDATED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId: id,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: `Addons updated for ${sub.institution.name}`,
    metadata: incoming as any,
  });

  return updated;
};

export const resendBill = async (institutionId: string, billId: string) => {
  const bill = await prisma.bill.findFirst({ where: { id: billId, institutionId } });
  if (!bill) throw new NotFoundError("Bill not found");

  const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
  if (!institution) throw new NotFoundError("Institution not found");

  const admin = await prisma.user.findFirst({
    where: { institutionId, role: "ADMIN" },
    select: { email: true },
  });
  if (!admin?.email) throw new NotFoundError("No admin email found for this institution");

  const { sendMonthlyBillEmail } = await import("../../services/email.service");
  const { ensurePaymentLink } = await import("../../services/razorpay.service");

  let linkUrl: string | undefined;
  try {
    const link = await ensurePaymentLink(billId);
    linkUrl = link.linkUrl;
  } catch (err) {
    console.error("resendBill: ensurePaymentLink failed:", (err as Error).message);
  }

  await sendMonthlyBillEmail({
    to: admin.email,
    institutionName: institution.name,
    billingMonth: bill.billingMonth ?? bill.type,
    totalAmount: bill.totalAmount,
    dueDate: bill.dueDate ?? new Date(),
    billId: bill.id,
    paymentLinkUrl: linkUrl,
  });

  return { sent: true, to: admin.email };
};

// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE / DOWNGRADE
// ─────────────────────────────────────────────────────────────────────────────

export const upgradePlan = async (id: string, actorId?: string) => {
  const institution = await prisma.institution.findUnique({
    where: { id },
    include: { subscription: { include: { plan: true } } },
  });
  if (!institution) throw new NotFoundError("Institution not found");
  if (!institution.subscription) throw new NotFoundError("Subscription not found");
  if (institution.subscription.plan.name !== "BASIC")
    throw new BadRequestError("Can only upgrade from BASIC plan");

  const proPlan = await prisma.plan.findFirst({ where: { name: "PRO" } });
  if (!proPlan) throw new NotFoundError("PRO plan not found");

  const updated = await prisma.subscription.update({
    where: { institutionId: id },
    data: { planId: proPlan.id },
    include: { plan: true },
  });

  await generateUpgradeProrationBill(id);

  await delCache(CACHE_KEYS.institutions, CACHE_KEYS.overview);
  logAudit("PLAN_UPGRADED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId: id,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: `${institution.name} upgraded from BASIC to PRO`,
    metadata: {},
  });

  return updated;
};

export const downgradePlan = async (id: string, actorId?: string) => {
  const institution = await prisma.institution.findUnique({
    where: { id },
    include: {
      subscription: { include: { plan: true } },
      _count: { select: { users: true } },
    },
  });
  if (!institution) throw new NotFoundError("Institution not found");
  if (!institution.subscription) throw new NotFoundError("Subscription not found");
  if (institution.subscription.plan.name !== "PRO")
    throw new BadRequestError("Can only downgrade from PRO plan");

  const basicPlan = await prisma.plan.findFirst({ where: { name: "BASIC" } });
  if (!basicPlan) throw new NotFoundError("BASIC plan not found");

  // Disable PRO-exclusive features in addons/features JSON
  const currentAddons = (institution.subscription.addons ?? {}) as Record<string, unknown>;
  const updatedAddons = {
    ...currentAddons,
    // PRO-only addon features become inactive on downgrade
    performanceInsightsAndAnalytics: { active: false },
    timetableAutoScheduling: { active: false },
  };

  const updated = await prisma.subscription.update({
    where: { institutionId: id },
    data: { planId: basicPlan.id, addons: updatedAddons },
    include: { plan: true },
  });

  await delCache(CACHE_KEYS.institutions, CACHE_KEYS.overview, `inst:access:${id}`);

  // Check storage usage — warn if above Basic limit (500GB)
  // We use the addon storage sum as a proxy; actual usage check is best-effort
  const addons = currentAddons as { extraStorage?: Array<{ active?: boolean; gbPurchased?: number }> };
  const extraStorageGb = (addons.extraStorage ?? [])
    .filter((s) => s.active)
    .reduce((sum, s) => sum + (s.gbPurchased ?? 0), 0);
  const storageWarning = extraStorageGb > 0; // any extra storage addon implies usage beyond 500GB base

  // Send notification email to admin
  const admin = await prisma.user.findFirst({
    where: { institutionId: id, role: "ADMIN" },
    select: { email: true },
  });
  if (admin?.email) {
    const { sendPlanDowngradeEmail } = await import("../../services/email.service");
    sendPlanDowngradeEmail({
      to: admin.email,
      institutionName: institution.name,
      storageWarning,
    }).catch((err) => console.error("Plan downgrade email failed:", err.message));
  }

  logAudit("PLAN_DOWNGRADED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId: id,
    category: "SUPERADMIN_ACTION",
    severity: "WARNING",
    details: `${institution.name} downgraded from PRO to BASIC`,
    metadata: { storageWarning, adminEmail: admin?.email },
  });

  return { ...updated, storageWarning };
};
