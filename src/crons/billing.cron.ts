import cron from "node-cron";
import {
  autoDeactivateOverdueInstitutions,
  generateMonthlyBills,
} from "../services/billing.service";

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
      } catch (err) {
        console.error("[Billing Cron] Error generating monthly bills:", err);
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
      } catch (err) {
        console.error("[Billing Cron] Error auto-deactivating overdue institutions:", err);
      }
    },
    { timezone: "Asia/Kolkata" },
  );

  console.log("[Billing Cron] Monthly billing cron scheduled (last day 11:59 PM IST + overdue check on 8th)");
}
