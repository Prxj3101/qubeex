import { prisma } from "../../utils/prisma";
import { generateToken, hashToken } from "../../utils/token";
import { sendInviteEmail } from "../../services/email.service";
import { logAudit } from "../../services/audit.service";
import { uploadImageToSupabase } from "../../services/storage.service";
import { generateInstitutionCode } from "../../utils/institutionCode";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "../../utils/errors";
import bcrypt from "bcrypt";

const BCRYPT_ROUNDS = 12;

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

  await logAudit("PROFILE_UPDATED", {
    userId,
    actorRole: "SUPER_ADMIN",
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

  await logAudit("PASSWORD_CHANGED", {
    userId,
    actorRole: "SUPER_ADMIN",
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
    prisma.institution.count(),
    prisma.institution.count({ where: { createdAt: { gte: startOfMonth } } }),
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
  const trialCount = await prisma.subscription.count({ where: { status: "TRIAL" } });
  const planDistribution = [
    ...Object.entries(planCounts).map(([plan, count]) => ({ plan, count })),
    { plan: "TRIAL", count: trialCount },
  ];

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
        where: { createdAt: { gte: start, lte: end }, status: "ACTIVE" },
      });
      const trial = await prisma.subscription.count({
        where: { createdAt: { gte: start, lte: end }, status: "TRIAL" },
      });
      return { month, active, trial };
    })
  );

  return {
    stats: {
      totalInstitutions,
      newInstitutionsThisMonth,
      pendingInvites,
      activeStudents: 0,       // placeholder — add when student model exists
      newStudentsThisWeek: 0,  // placeholder
      testsConducted: 0,       // placeholder
    },
    institutionGrowth,
    planDistribution,
    recentInstitutions,
    recentAuditLogs,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTITUTIONS
// ─────────────────────────────────────────────────────────────────────────────

export const createInstitutionService = async (data: any) => {
  const {
    name, email, type, adminName, adminEmail,
    phone, city, state, address, pincode, country,
    board, medium, logoUrl,
    plan: planName = "BASIC",
  } = data;

  const existingInstitution = await prisma.institution.findUnique({ where: { email } });
  if (existingInstitution) throw new ConflictError("Institution with this email already exists");

  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existingAdmin) throw new ConflictError("A user with this email already exists");

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Generate human-readable code before the transaction
  const institutionCode = await generateInstitutionCode(type);

  const institution = await prisma.$transaction(async (tx) => {
    const newInstitution = await tx.institution.create({
      data: {
        institutionCode,
        name, email, type, status: "PENDING",
        phone, city, state, address, pincode,
        country: country ?? "India",
        board, medium, logoUrl,
      },
    });

    await tx.user.create({
      data: {
        name: adminName,
        email: adminEmail,
        role: "ADMIN",
        institutionId: newInstitution.id,
        isActive: false,
      },
    });

    await tx.invite.create({
      data: {
        email: adminEmail,
        tokenHash,
        role: "ADMIN",
        institutionId: newInstitution.id,
        expiresAt,
      },
    });

    // Link the institution to the chosen plan
    const plan = await tx.plan.findFirst({ where: { name: planName } });
    if (plan) {
      await tx.subscription.create({
        data: {
          institutionId: newInstitution.id,
          planId: plan.id,
          status: "TRIAL",
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30-day trial
        },
      });
    }

    return newInstitution;
  });

  const inviteLink = `${process.env.FRONTEND_URL}/set-password?token=${rawToken}`;

  // Fire-and-forget — don't let email failure block institution creation
  sendInviteEmail({ to: adminEmail, name: adminName, inviteLink, institutionCode }).catch((err) =>
    console.error("⚠️  Invite email failed (non-blocking):", err.message)
  );

  await logAudit("INSTITUTION_CREATED", {
    institutionId: institution.id,
    details: `Created ${name} · Type: ${type}`,
    metadata: { institutionName: name, adminEmail },
  });

  return institution;
};


export const getInstitution = async () => {
  const institutions = await prisma.institution.findMany({
    include: {
      users: {
        omit: { password: true },
        orderBy: { createdAt: "asc" },
      },
      subscription: { include: { plan: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Attach role-level counts and pick the primary admin
  return institutions.map((inst) => {
    const admin    = inst.users.find((u) => u.role === "ADMIN") ?? null;
    const teachers = inst.users.filter((u) => (u.role as string) === "TEACHER").length;
    const students = inst.users.filter((u) => (u.role as string) === "STUDENT").length;

    return {
      ...inst,
      admin,          // full admin user object (name, email, isActive)
      teacherCount: teachers,
      studentCount: students,
    };
  });
};


export const getInstitutionById = async (id: string) => {
  const institution = await prisma.institution.findUnique({
    where: { id },
    include: {
      users: { omit: { password: true } },
      subscription: { include: { plan: true } },
    },
  });
  if (!institution) throw new NotFoundError("Institution not found");
  return institution;
};

export const updateInstitution = async (id: string, data: any) => {
  const existing = await prisma.institution.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Institution not found");
  return prisma.institution.update({ where: { id }, data });
};

export const uploadInstitutionLogo = async (
  file: Buffer,
  contentType: string,
  actorId?: string
) => {
  const uploaded = await uploadImageToSupabase(file, {
    contentType,
    folder: "institutions/logos",
    ownerId: actorId ?? "superadmin",
  });

  await logAudit("INSTITUTION_LOGO_UPLOADED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
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
  const existing = await prisma.institution.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Institution not found");

  const result = await prisma.institution.update({ where: { id }, data: { status } });

  const action = status === "ACTIVE"
    ? "INSTITUTION_ACTIVATED"
    : status === "SUSPENDED"
    ? "INSTITUTION_SUSPENDED"
    : "INSTITUTION_STATUS_CHANGED";

  await logAudit(action, {
    userId: actorId,
    actorRole,
    institutionId: id,
    details: `${existing.name} status changed to ${status}`,
    metadata: { newStatus: status },
  });

  return result;
};

export const resendInvite = async (email: string, institutionId: string) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new NotFoundError("User not found");

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.invite.create({
    data: { email, tokenHash, role: "ADMIN", institutionId: user.institutionId!, expiresAt },
  });

  const inviteLink = `${process.env.FRONTEND_URL}/set-password?token=${rawToken}`;
  sendInviteEmail({ to: user.email, inviteLink }).catch((err) =>
    console.error("⚠️  Resend invite email failed:", err.message)
  );

  await logAudit("INVITE_SENT", {
    institutionId,
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

export const getPlans = async () => {
  return prisma.plan.findMany({ orderBy: { basePrice: "asc" } });
};

export const getInstitutionPlan = async (id: string) => {
  const institution = await prisma.institution.findUnique({
    where: { id },
    include: { subscription: { include: { plan: true } } },
  });
  if (!institution) throw new NotFoundError("Institution not found");
  return institution.subscription;
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

  await logAudit("PLAN_ASSIGNED", {
    userId: actorId,
    actorRole,
    institutionId: id,
    details: `${institution.name} assigned to ${data.planName} plan with ${data.discount}% discount`,
    metadata: { plan: data.planName, discount: data.discount, paymentStatus: data.paymentStatus },
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

  await logAudit("NOTIFICATION_SENT", {
    userId: actorId,
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
        institution: { select: { name: true, type: true } },
        replies: { orderBy: { createdAt: "asc" } },
      },
    }),
    prisma.supportTicket.count({ where }),
  ]);

  return { tickets, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
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

export const replyToTicket = async (id: string, message: string) => {
  const existing = await prisma.supportTicket.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Ticket not found");

  const reply = await prisma.ticketReply.create({
    data: { ticketId: id, author: "Super Admin", role: "SUPER_ADMIN", message },
  });

  // Auto-move to IN_PROGRESS if still OPEN
  if (existing.status === "OPEN") {
    await prisma.supportTicket.update({ where: { id }, data: { status: "IN_PROGRESS" } });
  }

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

export const getAIUsage = async (_range: string) => {
  // Placeholder — real implementation requires an AIUsageLog model
  // populated whenever AI calls are made in the platform
  return {
    summary: {
      totalTokens: 0,
      totalCost: 0,
      avgCostPerInstitution: 0,
      totalRequests: 0,
    },
    trend: [],
    modelSplit: [],
    perInstitution: [],
  };
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
