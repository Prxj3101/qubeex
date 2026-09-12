import cron from "node-cron";
import { prisma } from "../utils/prisma";
import { logAudit } from "../services/audit.service";
import { sendTrialEndingEmail } from "../services/email.service";
import { recordCronRun } from "../services/cronTracker.service";
import { createNotification } from "../services/notification.service";

// ─── Daily: 9:00 AM IST (03:30 UTC) ─────────────────────────────────────────

async function runDailyTrialNotifications() {
  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  const trials = await prisma.subscription.findMany({
    where: { status: "TRIAL", startDate: { not: null } },
    include: { institution: true },
  });

  for (const sub of trials) {
    try {
      const endDate = sub.endDate ? new Date(sub.endDate) : null;
      if (!endDate) continue;

      // 3-day warning
      if (!sub.trialWarningSent && endDate <= in3Days && endDate > now) {
        const daysRemaining = Math.max(
          1,
          Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        );
        const formattedEndDate = endDate.toLocaleDateString("en-IN", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "Asia/Kolkata",
        });

        // Find institution admin
        const admin = await prisma.user.findFirst({
          where: { institutionId: sub.institutionId, role: "ADMIN" },
          select: { email: true },
        });

        if (admin) {
          await sendTrialEndingEmail({
            to: admin.email,
            institutionName: sub.institution.name,
            daysRemaining,
            trialEndDate: formattedEndDate,
          });
        } else {
          console.warn(`[Trial Cron] No ADMIN user found for institution ${sub.institutionId} — skipping email`);
        }

        // Dashboard notification for institution admin
        await createNotification({
          title: `Trial ending in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}`,
          message: `Your QubeEx trial for ${sub.institution.name} expires on ${formattedEndDate}. Contact your QubeEx administrator to activate a plan and avoid losing access.`,
          tag: "TRIAL",
          recipientType: "SPECIFIC",
          recipients: [{ institutionId: sub.institutionId }],
        });

        await prisma.subscription.update({
          where: { id: sub.id },
          data: { trialWarningSent: true },
        });

        console.log(`[Trial Cron] 3-day warning sent for institution ${sub.institutionId}`);
      }

      // Expiry notification to superadmin
      if (!sub.trialExpiryNotified && endDate <= now) {
        const formattedEndDate = endDate.toLocaleDateString("en-IN", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "Asia/Kolkata",
        });

        await createNotification({
          title: `Trial expired — ${sub.institution.name}`,
          message: `The trial for ${sub.institution.name} expired on ${formattedEndDate}. Activate a plan to restore access, or the institution will be auto-locked within 24 hours.`,
          tag: "TRIAL",
          recipientType: "SYSTEM",
        });

        await prisma.subscription.update({
          where: { id: sub.id },
          data: { trialExpiryNotified: true },
        });

        console.log(`[Trial Cron] Expiry notification created for institution ${sub.institutionId}`);
      }
    } catch (err) {
      console.error(`[Trial Cron] Daily notification error for institution ${sub.institutionId}:`, err);
    }
  }
}

// ─── Hourly: Auto-lock after 24h post-expiry ─────────────────────────────────

async function runHourlyAutoLock() {
  const lockBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const expired = await prisma.subscription.findMany({
    where: {
      status: "TRIAL",
      startDate: { not: null },
      endDate: { lt: lockBefore },
    },
    select: { id: true, institutionId: true },
  });

  for (const sub of expired) {
    try {
      await prisma.$transaction([
        prisma.subscription.update({
          where: { id: sub.id },
          data: { status: "LOCKED", trialOutcome: "CHURNED" },
        }),
        prisma.institution.update({
          where: { id: sub.institutionId },
          data: { status: "SUSPENDED" },
        }),
      ]);

      logAudit("TRIAL_AUTO_LOCKED", {
        actorRole: "SYSTEM",
        institutionId: sub.institutionId,
        details: "Institution auto-locked: trial expired with no plan activation within 24 hours",
        category: "SYSTEM",
        severity: "WARNING",
      });

      console.log(`[Trial Cron] Auto-locked institution ${sub.institutionId}`);
    } catch (err) {
      console.error(`[Trial Cron] Auto-lock error for institution ${sub.institutionId}:`, err);
    }
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export function startTrialCron() {
  // Daily at 9:00 AM IST (03:30 UTC)
  cron.schedule("30 3 * * *", async () => {
    console.log(`[Trial Cron] Running daily trial notifications at ${new Date().toISOString()}`);
    try {
      await runDailyTrialNotifications();
      await recordCronRun("trial-daily-notifications", true);
    } catch (err) {
      console.error("[Trial Cron] Daily notification run failed:", err);
      await recordCronRun("trial-daily-notifications", false, err instanceof Error ? err.message : "Unknown error");
    }
  }, { timezone: "Asia/Kolkata" });

  // Every hour
  cron.schedule("0 * * * *", async () => {
    console.log(`[Trial Cron] Running hourly auto-lock check at ${new Date().toISOString()}`);
    try {
      await runHourlyAutoLock();
      await recordCronRun("trial-auto-lock", true);
    } catch (err) {
      console.error("[Trial Cron] Hourly auto-lock run failed:", err);
      await recordCronRun("trial-auto-lock", false, err instanceof Error ? err.message : "Unknown error");
    }
  });

  console.log("[Trial Cron] Trial cron jobs scheduled (daily 9AM IST + hourly auto-lock)");
}
