import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError } from "../../utils/errors";
import { redis, isRedisReady } from "../../utils/redis";
import { getRate } from "../../services/billing.service";
import { getInstitutionStorageBytes } from "../../services/storage.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

type DotColor = "violet" | "emerald" | "amber" | "red" | "sky";

const ACTION_DOT: Record<string, DotColor> = {
  TEACHER_ADDED: "violet",
  TEACHER_UPDATED: "sky",
  TEACHER_DEACTIVATED: "red",
  CLASS_CREATED: "violet",
  CLASS_UPDATED: "sky",
  CLASS_DELETED: "red",
  SUBJECT_CREATED: "violet",
  SUBJECT_UPDATED: "sky",
  SUBJECT_DELETED: "red",
  DIVISION_CREATED: "violet",
  DIVISION_UPDATED: "sky",
  DIVISION_DELETED: "red",
  ANNOUNCEMENT_POSTED: "sky",
  POST_DELETED: "red",
  TEACHER_ASSIGNED: "emerald",
  TEACHER_UNASSIGNED: "amber",
  ADMIN_LOGIN: "emerald",
  LOGIN_FAILED: "red",
  SETTINGS_UPDATED: "amber",
  LOGO_UPDATED: "sky",
};

function actionLabel(action: string): string {
  return action
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const getOverview = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, role } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const [institution, userCount, teacherCount, studentCount, adminCount, classCount, subscription, recentLogs, recentTickets, teachersForGrowth, studentsForGrowth] =
      await Promise.all([
        prisma.institution.findUnique({
          where: { id: institutionId },
          select: { id: true, name: true, type: true, status: true, logoUrl: true, createdAt: true, adminPrefix: true },
        }),
        prisma.user.count({ where: { institutionId } }),
        prisma.teacher.count({ where: { institutionId } }),
        prisma.student.count({ where: { institutionId } }),
        prisma.user.count({ where: { institutionId, role: { in: ["ADMIN", "SUB_ADMIN"] } } }),
        prisma.standard.count({ where: { institutionId } }),
        prisma.subscription.findUnique({
          where: { institutionId },
          include: { plan: { select: { name: true } } },
        }),
        prisma.auditLog.findMany({
          where: { institutionId },
          orderBy: { createdAt: "desc" },
          take: 5,
          include: { user: { select: { name: true, email: true } } },
        }),
        prisma.supportTicket.findMany({
          where: { institutionId, status: { in: ["OPEN", "IN_PROGRESS"] } },
          orderBy: { createdAt: "desc" },
          take: 3,
          select: { id: true, title: true, category: true, priority: true, status: true, createdAt: true },
        }),
        // Teacher users for enrollment growth trend (createdAt grouped by month)
        prisma.user.findMany({
          where: { institutionId, role: "TEACHER" },
          select: { createdAt: true },
        }),
        // Student users for enrollment growth trend (createdAt grouped by month)
        prisma.user.findMany({
          where: { institutionId, role: "STUDENT" },
          select: { createdAt: true },
        }),
      ]);

    let aiUsage = { used: 0, limit: 0 };
    if (redis && isRedisReady) {
      try {
        const usageKey = `ai:usage:institution:${institutionId}`;
        const limitKey = `ai:limit:institution:${institutionId}`;
        const [usedRaw, limitRaw] = await Promise.all([
          redis.get(usageKey),
          redis.get(limitKey),
        ]);
        aiUsage = {
          used: Number(usedRaw ?? 0) || 0,
          limit: Number(limitRaw ?? 0) || 0,
        };
      } catch {
        aiUsage = { used: 0, limit: 0 };
      }
    }

    if (!institution) throw new BadRequestError("Institution not found");

    const daysSinceCreation = Math.floor(
      (Date.now() - institution.createdAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    const showWelcomeBanner = daysSinceCreation < 15;

    const enrollmentGrowth = Array.from({ length: 6 }, (_, i) => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - (5 - i));
      const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
      const month = endOfMonth.toLocaleString("en-US", { month: "short" });
      const teachers = teachersForGrowth.filter(u => u.createdAt <= endOfMonth).length;
      const students = studentsForGrowth.filter(u => u.createdAt <= endOfMonth).length;
      return { month, students, teachers };
    });

    // ── Plan usage ──
    const isTrial = !subscription || subscription.status === "TRIAL";
    const planName = subscription?.plan?.name ?? "Trial";
    const userLimit = isTrial ? 500 : 10000;
    // Storage limits in MB: Trial 10 GB, Pro 1 TB, Basic 500 GB.
    const storageLimit = isTrial ? 10 * 1024 : planName === "PRO" ? 1024 * 1024 : 500 * 1024;
    const storageUsedMb = (await getInstitutionStorageBytes(institutionId)) / (1024 * 1024);
    const testLimit = isTrial ? 500 : 10000;      // test tracking not yet wired
    const billedUsers = Math.max(200, userCount);
    const perUserRate = isTrial ? 0 : getRate(planName as "BASIC" | "PRO", billedUsers);
    const estMonthlyBill = perUserRate * billedUsers;

    // ── Audit logs ──
    const auditLogs = recentLogs.map(log => ({
      id: log.id,
      dot: (ACTION_DOT[log.action] ?? "amber") as DotColor,
      action: actionLabel(log.action),
      actor: log.user?.name ?? log.user?.email ?? "System",
      detail: log.details ?? "",
      time: relativeTime(log.createdAt),
    }));

    // ── Tickets ──
    const tickets = recentTickets.map(t => ({
      id: t.id,
      title: t.title,
      category: t.category as "BUG" | "FEATURE" | "BILLING" | "OTHER",
      priority: t.priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT",
      status: t.status as "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED",
      createdAt: relativeTime(t.createdAt),
    }));

    res.json({
      success: true,
      data: {
        institution: {
          id: institution.id,
          name: institution.name,
          type: institution.type,
          status: institution.status,
          logoUrl: institution.logoUrl,
          createdAt: institution.createdAt,
          adminPrefix: role === "ADMIN" ? institution.adminPrefix : null,
        },
        showWelcomeBanner,
        stats: {
          totalUsers: userCount,
          totalStudents: studentCount,
          totalTeachers: teacherCount,
          totalAdmins: adminCount,
          totalClasses: classCount,
        },
        enrollmentGrowth,
        plan: {
          name: planName,
          isTrial,
          activationDate: subscription?.activationDate ?? null,
          perUserRate,
          billedUsers,
          estMonthlyBill,
          usage: {
            users: { used: userCount, limit: userLimit },
            storage: { used: storageUsedMb, limit: storageLimit },
            tests: { used: 0, limit: testLimit },
            aiTokens: aiUsage,
          },
        },
        auditLogs,
        tickets,
      },
    });
  } catch (err) {
    next(err);
  }
};
