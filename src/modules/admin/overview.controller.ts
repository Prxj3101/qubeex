import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError } from "../../utils/errors";
import { getEffectiveRate, getMarginalBill, getBillingReferenceDate, prorateForMonth, PLAN_AI_TOKENS } from "../../services/billing.service";
import { getInstitutionStorageBytes } from "../../services/storage.service";
import { getInstitutionPoolUsed } from "../../services/ai-usage.service";

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
        academicDb().teacher.count({ where: { institutionId } }),
        academicDb().student.count({ where: { institutionId } }),
        prisma.user.count({ where: { institutionId, role: { in: ["ADMIN", "SUB_ADMIN"] } } }),
        academicDb().standard.count({ where: { institutionId } }),
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
    const planOption = subscription?.planOption ?? "NORMAL";
    const perUserRate = isTrial ? 0 : getEffectiveRate(planName as "BASIC" | "PRO", userCount, planOption);
    // "Est. Bill (this month)" must match what generateMonthlyBills will actually
    // charge — prorated for mid-month activation/reactivation, same reference
    // date and formula reused from the real billing run.
    const billingReferenceDate = getBillingReferenceDate(
      subscription?.activationDate ?? null,
      subscription?.lastResumedAt ?? null
    );
    const fullMonthBill = isTrial ? 0 : getMarginalBill(planName as "BASIC" | "PRO", userCount, planOption);
    const estMonthlyBill = isTrial ? 0 : prorateForMonth(fullMonthBill, new Date(), billingReferenceDate);

    // ── AI token limit ──
    // Derived from the plan (+ any active extraAiTokens addon) — Redis only
    // tracks the running "used" counter, the limit itself is never stored there.
    const tokenPlanName: "BASIC" | "PRO" | "TRIAL" = isTrial ? "TRIAL" : ((planName as "BASIC" | "PRO") ?? "BASIC");
    const addons = (subscription?.addons && typeof subscription.addons === "object" && !Array.isArray(subscription.addons))
      ? subscription.addons as Record<string, unknown>
      : {};
    const extraAiTokens = (addons.extraAiTokens as Array<{ active?: boolean; tokensPerMonth?: number }> ?? [])
      .filter((t) => t.active)
      .reduce((sum, t) => sum + (t.tokensPerMonth ?? 0), 0);
    const aiTokenLimit = PLAN_AI_TOKENS[tokenPlanName] + extraAiTokens;

    // Self-healing: reconciles against the AiUsageEvent log so a Redis
    // counter that fell behind (e.g. after a dropped connection) can't leave
    // this stat permanently understated — see getInstitutionPoolUsed.
    let aiUsage = { used: 0, limit: aiTokenLimit };
    try {
      aiUsage = { used: await getInstitutionPoolUsed(institutionId), limit: aiTokenLimit };
    } catch {
      aiUsage = { used: 0, limit: aiTokenLimit };
    }

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
          trialStartDate: subscription?.startDate ?? null,
          trialDaysTotal: subscription?.trialDays ?? null,
          perUserRate,
          billedUsers,
          estMonthlyBill,
          planOption,
          commitmentEndDate: subscription?.commitmentEndDate ?? null,
          usage: {
            users: { used: userCount, limit: userLimit },
            storage: { used: storageUsedMb, limit: storageLimit },
            tests: { used: 0, limit: testLimit },
            aiTokens: {
              ...aiUsage,
              // Token pool is a calendar-month allowance — resets the 1st of next month.
              resetsAt: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(),
            },
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
