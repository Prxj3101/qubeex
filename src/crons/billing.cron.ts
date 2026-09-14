import cron from "node-cron";
import {
  autoDeactivateOverdueInstitutions,
  generateMonthlyBills,
} from "../services/billing.service";
import { prisma } from "../utils/prisma";
import { recordCronRun } from "../services/cronTracker.service";
import { createNotification } from "../services/notification.service";

// Runs at 23:59 on the last day of every month (IST = UTC+5:30 → 18:29 UTC)
// Cron: minute hour day-of-month month day-of-week
// "59 18 28-31 * *" — fires on days 28-31 at 18:29 UTC; the function skips if it's not actually the last day.
export function startBillingCron() {
  cron.schedule(
    "59 18 28-31 * *",
    async () => {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);

      // Only run on the actual last day of the month
      if (tomorrow.getDate() !== 1) return;

      console.log(`[Billing Cron] Running monthly bill generation for ${now.toISOString()}`);
      try {
        await generateMonthlyBills();
        // Notify institutions that have an unpaid bill for this month
        const billingMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const unpaidBills = await prisma.bill.findMany({
          where: { billingMonth, type: "MONTHLY", status: "PENDING" },
          select: { institutionId: true },
        });
        // Idempotency: skip institutions already notified this month
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const alreadyNotified = await prisma.notificationRecipient.findMany({
          where: {
            institutionId: { in: unpaidBills.map(b => b.institutionId) },
            notification: { tag: "PLAN_EXPIRY", createdAt: { gte: startOfMonth } },
          },
          select: { institutionId: true },
        });
        const notifiedSet = new Set(alreadyNotified.map(r => r.institutionId));
        const toNotify = unpaidBills.filter(b => !notifiedSet.has(b.institutionId));
        for (const bill of toNotify) {
          await createNotification({
            title: "Your monthly bill is ready",
            message: "Your bill has been generated. Please pay by the 8th to avoid service interruption.",
            tag: "PLAN_EXPIRY",
            recipientType: "SYSTEM",
            recipients: [{ institutionId: bill.institutionId }],
            adminOnly: true,
          });
        }
        console.log(`[Billing Cron] Sent bill notifications to ${toNotify.length} institution(s)`);
        await recordCronRun("billing-monthly-bills", true);
      } catch (err) {
        console.error("[Billing Cron] Error generating monthly bills:", err);
        await recordCronRun("billing-monthly-bills", false, err instanceof Error ? err.message : "Unknown error");
      }
    },
    { timezone: "Asia/Kolkata" },
  );

  // Runs every month on the 8th at 12:05 AM IST, after the payment due date.
  cron.schedule(
    "5 0 8 * *",
    async () => {
      console.log(`[Billing Cron] Running overdue payment deactivation at ${new Date().toISOString()}`);
      try {
        await autoDeactivateOverdueInstitutions();
        await recordCronRun("billing-overdue-deactivation", true);
      } catch (err) {
        console.error("[Billing Cron] Error auto-deactivating overdue institutions:", err);
        await recordCronRun("billing-overdue-deactivation", false, err instanceof Error ? err.message : "Unknown error");
      }
    },
    { timezone: "Asia/Kolkata" },
  );

  // Runs on the 5th of every month at 9:00 AM IST — payment reminder (3 days before deactivation)
  cron.schedule(
    "0 9 5 * *",
    async () => {
      console.log(`[Billing Cron] Sending payment reminder notifications at ${new Date().toISOString()}`);
      try {
        const now = new Date();
        const billingMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const unpaidBills = await prisma.bill.findMany({
          where: { billingMonth, type: "MONTHLY", status: "PENDING" },
          select: { institutionId: true },
        });
        // Idempotency: skip institutions that already received a reminder this month
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const alreadyReminded = await prisma.notificationRecipient.findMany({
          where: {
            institutionId: { in: unpaidBills.map(b => b.institutionId) },
            notification: {
              tag: "PLAN_EXPIRY",
              title: "Payment reminder — 3 days left",
              createdAt: { gte: startOfMonth },
            },
          },
          select: { institutionId: true },
        });
        const remindedSet = new Set(alreadyReminded.map(r => r.institutionId));
        const toRemind = unpaidBills.filter(b => !remindedSet.has(b.institutionId));
        for (const bill of toRemind) {
          await createNotification({
            title: "Payment reminder — 3 days left",
            message: "Your account will be suspended on the 8th if payment is not received. Please pay now.",
            tag: "PLAN_EXPIRY",
            recipientType: "SYSTEM",
            recipients: [{ institutionId: bill.institutionId }],
            adminOnly: true,
          });
        }
        console.log(`[Billing Cron] Sent payment reminders to ${toRemind.length} institution(s)`);
        await recordCronRun("billing-payment-reminder", true);
      } catch (err) {
        console.error("[Billing Cron] Error sending payment reminders:", err);
        await recordCronRun("billing-payment-reminder", false, err instanceof Error ? err.message : "Unknown error");
      }
    },
    { timezone: "Asia/Kolkata" },
  );

  console.log("[Billing Cron] Scheduled: bill generation (last day), overdue check (8th), payment reminder (5th)");
}
