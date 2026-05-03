"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVaultStats = exports.getAIUsage = exports.getSystemHealth = exports.replyToReview = exports.getReviews = exports.replyToTicket = exports.updateTicketStatus = exports.getTicketById = exports.getTickets = exports.getNotifications = exports.broadcastNotification = exports.updateInstitutionFeatures = exports.updateInstitutionPlan = exports.getInstitutionPlan = exports.getPlans = exports.getAuditLogs = exports.resendInvite = exports.toggleInstitutionStatus = exports.uploadInstitutionLogo = exports.updateInstitution = exports.getInstitutionById = exports.getInstitution = exports.createInstitutionService = exports.getOverviewStats = exports.getProfileLoginActivity = exports.changeProfilePassword = exports.updateProfile = exports.getProfile = void 0;
const prisma_1 = require("../../utils/prisma");
const token_1 = require("../../utils/token");
const email_service_1 = require("../../services/email.service");
const audit_service_1 = require("../../services/audit.service");
const storage_service_1 = require("../../services/storage.service");
const institutionCode_1 = require("../../utils/institutionCode");
const errors_1 = require("../../utils/errors");
const cache_1 = require("../../utils/cache");
const bcrypt_1 = __importDefault(require("bcrypt"));
const CACHE_KEYS = {
    overview: "cache:overview",
    institutions: "cache:institutions",
};
const BCRYPT_ROUNDS = 12;
const toProfileResponse = (user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
});
const getDeviceName = (userAgent) => {
    if (!userAgent || userAgent === "unknown")
        return "Unknown device";
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
const getProfile = async (userId) => {
    const user = await prisma_1.prisma.user.findFirst({
        where: { id: userId, role: "SUPER_ADMIN" },
    });
    if (!user)
        throw new errors_1.NotFoundError("Super admin profile not found");
    return toProfileResponse(user);
};
exports.getProfile = getProfile;
const updateProfile = async (userId, data) => {
    const existing = await prisma_1.prisma.user.findUnique({
        where: { id: userId },
    });
    if (!existing || existing.role !== "SUPER_ADMIN") {
        throw new errors_1.NotFoundError("Super admin profile not found");
    }
    if (data.email !== existing.email) {
        const emailOwner = await prisma_1.prisma.user.findUnique({ where: { email: data.email } });
        if (emailOwner && emailOwner.id !== userId) {
            throw new errors_1.ConflictError("A user with this email already exists");
        }
    }
    const user = await prisma_1.prisma.user.update({
        where: { id: userId },
        data: {
            name: data.name,
            email: data.email,
        },
    });
    await (0, audit_service_1.logAudit)("PROFILE_UPDATED", {
        userId,
        actorRole: "SUPER_ADMIN",
        details: `Super admin profile updated for ${user.email}`,
        metadata: { email: user.email },
    });
    return toProfileResponse(user);
};
exports.updateProfile = updateProfile;
const changeProfilePassword = async (userId, data) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: userId },
    });
    if (!user || user.role !== "SUPER_ADMIN") {
        throw new errors_1.NotFoundError("Super admin profile not found");
    }
    if (!user.password)
        throw new errors_1.BadRequestError("Password is not set for this account");
    const isMatch = await bcrypt_1.default.compare(data.oldPassword, user.password);
    if (!isMatch)
        throw new errors_1.UnauthorizedError("Current password is incorrect");
    const isSamePassword = await bcrypt_1.default.compare(data.newPassword, user.password);
    if (isSamePassword)
        throw new errors_1.BadRequestError("New password must be different from current password");
    const hashedPassword = await bcrypt_1.default.hash(data.newPassword, BCRYPT_ROUNDS);
    await prisma_1.prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
    });
    await (0, audit_service_1.logAudit)("PASSWORD_CHANGED", {
        userId,
        actorRole: "SUPER_ADMIN",
        details: `Password changed for ${user.email}`,
        metadata: { email: user.email },
    });
    return { message: "Password changed successfully" };
};
exports.changeProfilePassword = changeProfilePassword;
const getProfileLoginActivity = async (userId, limit = 10) => {
    const logs = await prisma_1.prisma.auditLog.findMany({
        where: {
            action: "LOGIN_SUCCESS",
            userId,
            actorRole: "SUPER_ADMIN",
        },
        take: Math.min(Math.max(limit, 1), 30),
        orderBy: { createdAt: "desc" },
    });
    return logs.map((log, index) => {
        const metadata = log.metadata;
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
exports.getProfileLoginActivity = getProfileLoginActivity;
// ─────────────────────────────────────────────────────────────────────────────
// OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────
const getOverviewStats = async () => {
    const cached = await (0, cache_1.getCache)(CACHE_KEYS.overview);
    if (cached)
        return cached;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - 7);
    const [totalInstitutions, newInstitutionsThisMonth, pendingInvites, recentInstitutions, recentAuditLogs, subscriptions,] = await Promise.all([
        prisma_1.prisma.institution.count(),
        prisma_1.prisma.institution.count({ where: { createdAt: { gte: startOfMonth } } }),
        prisma_1.prisma.invite.count({ where: { isUsed: false, expiresAt: { gt: now } } }),
        prisma_1.prisma.institution.findMany({
            take: 5,
            orderBy: { createdAt: "desc" },
            include: {
                subscription: { include: { plan: true } },
                users: { select: { role: true } },
            },
        }),
        prisma_1.prisma.auditLog.findMany({
            take: 5,
            orderBy: { createdAt: "desc" },
            include: { institution: { select: { id: true, name: true } } },
        }),
        prisma_1.prisma.subscription.findMany({ include: { plan: true } }),
    ]);
    // Plan distribution
    const planCounts = {};
    for (const sub of subscriptions) {
        const name = sub.plan.name;
        planCounts[name] = (planCounts[name] ?? 0) + 1;
    }
    const trialCount = await prisma_1.prisma.subscription.count({ where: { status: "TRIAL" } });
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
    const institutionGrowth = await Promise.all(months.map(async ({ month, start, end }) => {
        const active = await prisma_1.prisma.institution.count({
            where: { createdAt: { gte: start, lte: end }, status: "ACTIVE" },
        });
        const trial = await prisma_1.prisma.subscription.count({
            where: { createdAt: { gte: start, lte: end }, status: "TRIAL" },
        });
        return { month, active, trial };
    }));
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
    await (0, cache_1.setCache)(CACHE_KEYS.overview, result, 60);
    return result;
};
exports.getOverviewStats = getOverviewStats;
// ─────────────────────────────────────────────────────────────────────────────
// INSTITUTIONS
// ─────────────────────────────────────────────────────────────────────────────
const createInstitutionService = async (data) => {
    const { name, email, type, adminName, adminEmail, phone, city, state, address, pincode, country, board, medium, logoUrl, plan: selectedPlan = "BASIC", trialDays = 14, } = data;
    const postTrialPlanName = selectedPlan === "TRIAL" ? "BASIC" : selectedPlan;
    const existingInstitution = await prisma_1.prisma.institution.findUnique({ where: { email } });
    if (existingInstitution)
        throw new errors_1.ConflictError("Institution with this email already exists");
    const existingAdmin = await prisma_1.prisma.user.findUnique({ where: { email: adminEmail } });
    if (existingAdmin)
        throw new errors_1.ConflictError("A user with this email already exists");
    const rawToken = (0, token_1.generateToken)();
    const tokenHash = (0, token_1.hashToken)(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // Generate human-readable code before the transaction
    const institutionCode = await (0, institutionCode_1.generateInstitutionCode)(type);
    const institution = await prisma_1.prisma.$transaction(async (tx) => {
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
        // Link the institution to the chosen post-trial plan. Subscription remains
        // TRIAL until the superadmin activates payment from Manage Plan.
        const plan = await tx.plan.findFirst({ where: { name: postTrialPlanName } });
        if (!plan) {
            throw new errors_1.NotFoundError(`Plan '${postTrialPlanName}' not found`);
        }
        const trialStart = new Date();
        const trialEnd = new Date(trialStart);
        trialEnd.setDate(trialEnd.getDate() + trialDays);
        await tx.subscription.create({
            data: {
                institutionId: newInstitution.id,
                planId: plan.id,
                status: "TRIAL",
                startDate: trialStart,
                endDate: trialEnd,
            },
        });
        return newInstitution;
    });
    const inviteLink = `${process.env.FRONTEND_URL}/set-password?token=${rawToken}`;
    // Fire-and-forget — don't let email failure block institution creation
    (0, email_service_1.sendInviteEmail)({ to: adminEmail, name: adminName, inviteLink, institutionCode }).catch((err) => console.error("⚠️  Invite email failed (non-blocking):", err.message));
    await (0, audit_service_1.logAudit)("INSTITUTION_CREATED", {
        institutionId: institution.id,
        details: `Created ${name} · Type: ${type}`,
        metadata: {
            institutionName: name,
            adminEmail,
            selectedPlan,
            postTrialPlan: postTrialPlanName,
            trialDays,
        },
    });
    await (0, cache_1.delCache)(CACHE_KEYS.institutions, CACHE_KEYS.overview);
    return institution;
};
exports.createInstitutionService = createInstitutionService;
const getInstitution = async () => {
    const cached = await (0, cache_1.getCache)(CACHE_KEYS.institutions);
    if (cached)
        return cached;
    const institutions = await prisma_1.prisma.institution.findMany({
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
    const result = institutions.map((inst) => {
        const admin = inst.users.find((u) => u.role === "ADMIN") ?? null;
        const teachers = inst.users.filter((u) => u.role === "TEACHER").length;
        const students = inst.users.filter((u) => u.role === "STUDENT").length;
        return {
            ...inst,
            admin,
            teacherCount: teachers,
            studentCount: students,
        };
    });
    await (0, cache_1.setCache)(CACHE_KEYS.institutions, result, 30);
    return result;
};
exports.getInstitution = getInstitution;
const getInstitutionById = async (id) => {
    const institution = await prisma_1.prisma.institution.findUnique({
        where: { id },
        include: {
            users: { omit: { password: true } },
            subscription: { include: { plan: true } },
        },
    });
    if (!institution)
        throw new errors_1.NotFoundError("Institution not found");
    return institution;
};
exports.getInstitutionById = getInstitutionById;
const updateInstitution = async (id, data) => {
    const existing = await prisma_1.prisma.institution.findUnique({ where: { id } });
    if (!existing)
        throw new errors_1.NotFoundError("Institution not found");
    const result = await prisma_1.prisma.institution.update({ where: { id }, data });
    await (0, cache_1.delCache)(CACHE_KEYS.institutions);
    return result;
};
exports.updateInstitution = updateInstitution;
const uploadInstitutionLogo = async (file, contentType, actorId) => {
    const uploaded = await (0, storage_service_1.uploadImageToSupabase)(file, {
        contentType,
        folder: "institutions/logos",
        ownerId: actorId ?? "superadmin",
    });
    await (0, audit_service_1.logAudit)("INSTITUTION_LOGO_UPLOADED", {
        userId: actorId,
        actorRole: "SUPER_ADMIN",
        details: "Institution logo uploaded",
        metadata: { path: uploaded.path, publicUrl: uploaded.publicUrl },
    });
    return { logoUrl: uploaded.publicUrl, path: uploaded.path };
};
exports.uploadInstitutionLogo = uploadInstitutionLogo;
const toggleInstitutionStatus = async (id, status, actorId, actorRole) => {
    const existing = await prisma_1.prisma.institution.findUnique({ where: { id } });
    if (!existing)
        throw new errors_1.NotFoundError("Institution not found");
    const result = await prisma_1.prisma.institution.update({ where: { id }, data: { status } });
    await (0, cache_1.delCache)(CACHE_KEYS.institutions, CACHE_KEYS.overview);
    const action = status === "ACTIVE"
        ? "INSTITUTION_ACTIVATED"
        : status === "SUSPENDED"
            ? "INSTITUTION_SUSPENDED"
            : "INSTITUTION_STATUS_CHANGED";
    await (0, audit_service_1.logAudit)(action, {
        userId: actorId,
        actorRole,
        institutionId: id,
        details: `${existing.name} status changed to ${status}`,
        metadata: { newStatus: status },
    });
    return result;
};
exports.toggleInstitutionStatus = toggleInstitutionStatus;
const resendInvite = async (email, institutionId) => {
    const user = await prisma_1.prisma.user.findUnique({ where: { email } });
    if (!user)
        throw new errors_1.NotFoundError("User not found");
    const rawToken = (0, token_1.generateToken)();
    const tokenHash = (0, token_1.hashToken)(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma_1.prisma.invite.create({
        data: { email, tokenHash, role: "ADMIN", institutionId: user.institutionId, expiresAt },
    });
    const inviteLink = `${process.env.FRONTEND_URL}/set-password?token=${rawToken}`;
    (0, email_service_1.sendInviteEmail)({ to: user.email, inviteLink }).catch((err) => console.error("⚠️  Resend invite email failed:", err.message));
    await (0, audit_service_1.logAudit)("INVITE_SENT", {
        institutionId,
        details: `Invite resent to ${email}`,
        metadata: { email },
    });
    return { message: "Invite resent successfully" };
};
exports.resendInvite = resendInvite;
// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────
const getAuditLogs = async (query) => {
    const { action, institutionId, actorRole, from, to, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where = {};
    if (action)
        where.action = { contains: action, mode: "insensitive" };
    if (institutionId)
        where.institutionId = institutionId;
    if (actorRole)
        where.actorRole = actorRole;
    if (from || to) {
        where.createdAt = {};
        if (from)
            where.createdAt.gte = new Date(from);
        if (to)
            where.createdAt.lte = new Date(to);
    }
    const [logs, total] = await Promise.all([
        prisma_1.prisma.auditLog.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: "desc" },
            include: {
                user: { select: { id: true, name: true, email: true } },
                institution: { select: { id: true, name: true, institutionCode: true } },
            },
        }),
        prisma_1.prisma.auditLog.count({ where }),
    ]);
    return {
        logs,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    };
};
exports.getAuditLogs = getAuditLogs;
// ─────────────────────────────────────────────────────────────────────────────
// PLAN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
const getPlans = async () => {
    return prisma_1.prisma.plan.findMany({ orderBy: { basePrice: "asc" } });
};
exports.getPlans = getPlans;
const getInstitutionPlan = async (id) => {
    const institution = await prisma_1.prisma.institution.findUnique({
        where: { id },
        include: { subscription: { include: { plan: true } } },
    });
    if (!institution)
        throw new errors_1.NotFoundError("Institution not found");
    return institution.subscription;
};
exports.getInstitutionPlan = getInstitutionPlan;
const updateInstitutionPlan = async (id, data, actorId, actorRole) => {
    const institution = await prisma_1.prisma.institution.findUnique({ where: { id } });
    if (!institution)
        throw new errors_1.NotFoundError("Institution not found");
    const plan = await prisma_1.prisma.plan.findFirst({ where: { name: data.planName } });
    if (!plan)
        throw new errors_1.NotFoundError(`Plan '${data.planName}' not found`);
    const subscription = await prisma_1.prisma.subscription.upsert({
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
    await (0, audit_service_1.logAudit)("PLAN_ASSIGNED", {
        userId: actorId,
        actorRole,
        institutionId: id,
        details: `${institution.name} assigned to ${data.planName} plan with ${data.discount}% discount`,
        metadata: { plan: data.planName, discount: data.discount, paymentStatus: data.paymentStatus },
    });
    return subscription;
};
exports.updateInstitutionPlan = updateInstitutionPlan;
const updateInstitutionFeatures = async (id, features) => {
    const existing = await prisma_1.prisma.institution.findUnique({ where: { id } });
    if (!existing)
        throw new errors_1.NotFoundError("Institution not found");
    const subscription = await prisma_1.prisma.subscription.findUnique({ where: { institutionId: id } });
    if (!subscription)
        throw new errors_1.NotFoundError("No subscription found for this institution");
    return prisma_1.prisma.subscription.update({
        where: { institutionId: id },
        data: { features },
    });
};
exports.updateInstitutionFeatures = updateInstitutionFeatures;
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
const broadcastNotification = async (data, actorId) => {
    // Determine target institution IDs
    let targetInstitutions = [];
    if (data.recipient === "ALL") {
        targetInstitutions = await prisma_1.prisma.institution.findMany({ select: { id: true } });
    }
    else if (data.recipient === "SPECIFIC") {
        targetInstitutions = (data.institutionIds ?? []).map((id) => ({ id }));
    }
    else {
        targetInstitutions = await prisma_1.prisma.institution.findMany({
            where: { type: data.recipient },
            select: { id: true },
        });
    }
    const notification = await prisma_1.prisma.notification.create({
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
    await (0, audit_service_1.logAudit)("NOTIFICATION_SENT", {
        userId: actorId,
        details: `Broadcast: "${data.title}" → ${targetInstitutions.length} institutions`,
        metadata: { tag: data.tag, recipient: data.recipient },
    });
    return notification;
};
exports.broadcastNotification = broadcastNotification;
const getNotifications = async (page = 1, limit = 20) => {
    const skip = (page - 1) * limit;
    const [notifications, total] = await Promise.all([
        prisma_1.prisma.notification.findMany({
            skip,
            take: limit,
            orderBy: { createdAt: "desc" },
        }),
        prisma_1.prisma.notification.count(),
    ]);
    return { notifications, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
};
exports.getNotifications = getNotifications;
// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT TICKETS
// ─────────────────────────────────────────────────────────────────────────────
const getTickets = async (query) => {
    const { status, category, search, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where = {};
    if (status)
        where.status = status;
    if (category)
        where.category = category;
    if (search) {
        where.OR = [
            { title: { contains: search, mode: "insensitive" } },
            { adminEmail: { contains: search, mode: "insensitive" } },
            { institution: { name: { contains: search, mode: "insensitive" } } },
        ];
    }
    const [tickets, total] = await Promise.all([
        prisma_1.prisma.supportTicket.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: "desc" },
            include: {
                institution: { select: { name: true, type: true } },
                replies: { orderBy: { createdAt: "asc" } },
            },
        }),
        prisma_1.prisma.supportTicket.count({ where }),
    ]);
    return { tickets, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
};
exports.getTickets = getTickets;
const getTicketById = async (id) => {
    const ticket = await prisma_1.prisma.supportTicket.findUnique({
        where: { id },
        include: {
            institution: { select: { name: true, type: true } },
            replies: { orderBy: { createdAt: "asc" } },
        },
    });
    if (!ticket)
        throw new errors_1.NotFoundError("Ticket not found");
    return ticket;
};
exports.getTicketById = getTicketById;
const updateTicketStatus = async (id, status) => {
    const existing = await prisma_1.prisma.supportTicket.findUnique({ where: { id } });
    if (!existing)
        throw new errors_1.NotFoundError("Ticket not found");
    return prisma_1.prisma.supportTicket.update({ where: { id }, data: { status } });
};
exports.updateTicketStatus = updateTicketStatus;
const replyToTicket = async (id, message) => {
    const existing = await prisma_1.prisma.supportTicket.findUnique({ where: { id } });
    if (!existing)
        throw new errors_1.NotFoundError("Ticket not found");
    const reply = await prisma_1.prisma.ticketReply.create({
        data: { ticketId: id, author: "Super Admin", role: "SUPER_ADMIN", message },
    });
    // Auto-move to IN_PROGRESS if still OPEN
    if (existing.status === "OPEN") {
        await prisma_1.prisma.supportTicket.update({ where: { id }, data: { status: "IN_PROGRESS" } });
    }
    return reply;
};
exports.replyToTicket = replyToTicket;
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWS
// ─────────────────────────────────────────────────────────────────────────────
const getReviews = async (query) => {
    const { type, rating, search, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where = {};
    if (rating)
        where.rating = rating;
    if (type)
        where.institution = { type };
    if (search) {
        where.OR = [
            { title: { contains: search, mode: "insensitive" } },
            { body: { contains: search, mode: "insensitive" } },
            { adminName: { contains: search, mode: "insensitive" } },
            { institution: { name: { contains: search, mode: "insensitive" } } },
        ];
    }
    const [reviews, total] = await Promise.all([
        prisma_1.prisma.review.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: "desc" },
            include: { institution: { select: { name: true, type: true } } },
        }),
        prisma_1.prisma.review.count({ where }),
    ]);
    return { reviews, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
};
exports.getReviews = getReviews;
const replyToReview = async (id, message) => {
    const existing = await prisma_1.prisma.review.findUnique({ where: { id } });
    if (!existing)
        throw new errors_1.NotFoundError("Review not found");
    if (existing.replyMessage)
        throw new errors_1.ConflictError("This review already has a reply");
    return prisma_1.prisma.review.update({
        where: { id },
        data: { replyMessage: message, repliedAt: new Date() },
    });
};
exports.replyToReview = replyToReview;
// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM HEALTH
// ─────────────────────────────────────────────────────────────────────────────
const getSystemHealth = async () => {
    // Live DB check
    let dbStatus = "operational";
    let dbLatency = 0;
    try {
        const start = Date.now();
        await prisma_1.prisma.$queryRaw `SELECT 1`;
        dbLatency = Date.now() - start;
    }
    catch {
        dbStatus = "down";
    }
    const services = [
        { name: "API Server", status: "operational", uptime: "99.98%", latency: "—", region: "Mumbai" },
        { name: "Database", status: dbStatus, uptime: "99.99%", latency: `${dbLatency}ms`, region: "Mumbai" },
        { name: "Queue (Redis)", status: "operational", uptime: "99.85%", latency: "—", region: "Mumbai" },
        { name: "Storage (S3)", status: "operational", uptime: "99.95%", latency: "—", region: "Global" },
        { name: "AI (Claude)", status: "operational", uptime: "99.90%", latency: "—", region: "Global" },
        { name: "Email (Resend)", status: "operational", uptime: "99.85%", latency: "—", region: "Global" },
    ];
    // Recent errors from audit logs
    const recentErrors = await prisma_1.prisma.auditLog.findMany({
        where: { action: { in: ["LOGIN_FAILED", "INVITE_SENT"] } },
        take: 5,
        orderBy: { createdAt: "desc" },
    });
    return {
        services,
        queues: [
            { name: "Email Queue", pending: 0, processing: 0, failed: 0, color: "#7C3AED" },
            { name: "Test Evaluation", pending: 0, processing: 0, failed: 0, color: "#F59E0B" },
            { name: "Report Generation", pending: 0, processing: 0, failed: 0, color: "#10B981" },
            { name: "AI Processing", pending: 0, processing: 0, failed: 0, color: "#2563EB" },
        ],
        recentErrors,
    };
};
exports.getSystemHealth = getSystemHealth;
// ─────────────────────────────────────────────────────────────────────────────
// AI USAGE
// ─────────────────────────────────────────────────────────────────────────────
const getAIUsage = async (_range) => {
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
exports.getAIUsage = getAIUsage;
// ─────────────────────────────────────────────────────────────────────────────
// VAULT
// ─────────────────────────────────────────────────────────────────────────────
const getVaultStats = async () => {
    const activeSubscriptions = await prisma_1.prisma.subscription.findMany({
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
exports.getVaultStats = getVaultStats;
