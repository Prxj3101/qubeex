import cron from "node-cron";
import { prisma } from "../utils/prisma";
import { recordCronRun } from "../services/cronTracker.service";

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export async function runAuditRetention(): Promise<void> {
  try {
    const system = await prisma.auditLog.deleteMany({
      where: {
        category: "SYSTEM",
        severity: { not: "CRITICAL" },
        createdAt: { lt: daysAgo(30) },
      },
    });

    const securityInfo = await prisma.auditLog.deleteMany({
      where: {
        category: "SECURITY",
        severity: "INFO",
        createdAt: { lt: daysAgo(90) },
      },
    });

    const securityWarning = await prisma.auditLog.deleteMany({
      where: {
        category: "SECURITY",
        severity: "WARNING",
        createdAt: { lt: daysAgo(365) },
      },
    });

    const admin = await prisma.auditLog.deleteMany({
      where: {
        category: "ADMIN_ACTION",
        severity: { not: "CRITICAL" },
        createdAt: { lt: daysAgo(365) },
      },
    });

    const billing = await prisma.auditLog.deleteMany({
      where: {
        category: { in: ["BILLING", "SUPERADMIN_ACTION"] },
        severity: { not: "CRITICAL" },
        createdAt: { lt: daysAgo(730) },
      },
    });

    const total = system.count + securityInfo.count + securityWarning.count + admin.count + billing.count;
    if (total > 0) {
      console.log(
        `[Audit Retention] Purged ${total} rows (system=${system.count}, secInfo=${securityInfo.count}, secWarn=${securityWarning.count}, admin=${admin.count}, billing=${billing.count})`
      );
    }
    await recordCronRun("audit-retention", true);
  } catch (err) {
    console.error("[Audit Retention] Failed:", err);
    await recordCronRun("audit-retention", false, err instanceof Error ? err.message : "Unknown error");
  }
}

// Runs at 2:00 AM IST (20:30 UTC) every Sunday
export function startAuditRetentionCron(): void {
  cron.schedule("30 20 * * 0", runAuditRetention, { timezone: "UTC" });
  console.log("[Audit Retention Cron] Scheduled — Sundays 2:00 AM IST");
}
