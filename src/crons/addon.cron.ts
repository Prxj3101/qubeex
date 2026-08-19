import cron from "node-cron";
import { prisma } from "../utils/prisma";
import { logAudit } from "../services/audit.service";
import { sendSmartBoardFreeExpiryEmail } from "../services/email.service";
import { recordCronRun } from "../services/cronTracker.service";

type SmartBoardAddonState = {
  active?: boolean;
  isInFreePeriod?: boolean;
  freeEndDate?: string;
  freeExpiry30DayAlertSent?: boolean;
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;

async function runSmartBoardFreeExpiryAlerts() {
  const subscriptions = await prisma.subscription.findMany({
    where: { status: "ACTIVE" },
    include: {
      institution: true,
    },
  });

  const now = Date.now();

  for (const sub of subscriptions) {
    const addons = (sub.addons ?? {}) as Record<string, unknown>;
    const smartBoard = addons.smartBoardAi as SmartBoardAddonState | undefined;
    if (!smartBoard || !smartBoard.active || !smartBoard.isInFreePeriod || !smartBoard.freeEndDate) {
      continue;
    }
    if (smartBoard.freeExpiry30DayAlertSent) continue;

    const freeEndTs = new Date(smartBoard.freeEndDate).getTime();
    const diff = freeEndTs - now;
    if (diff > THIRTY_ONE_DAYS_MS || diff < THIRTY_DAYS_MS) continue;

    const formattedEndDate = new Date(smartBoard.freeEndDate).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    });

    const [adminUser, superAdminUser] = await Promise.all([
      prisma.user.findFirst({
        where: { institutionId: sub.institutionId, role: "ADMIN" },
        select: { email: true },
      }),
      prisma.user.findFirst({
        where: { role: "SUPER_ADMIN" },
        select: { email: true },
      }),
    ]);

    if (adminUser?.email) {
      await sendSmartBoardFreeExpiryEmail({
        to: adminUser.email,
        institutionName: sub.institution.name,
        freeEndDate: formattedEndDate,
      });
    }
    if (superAdminUser?.email) {
      await sendSmartBoardFreeExpiryEmail({
        to: superAdminUser.email,
        institutionName: sub.institution.name,
        freeEndDate: formattedEndDate,
      });
    }

    await prisma.notification.create({
      data: {
        title: `Smart Board free period ends in 30 days — ${sub.institution.name}`,
        message: `The Smart Board + AI free period for ${sub.institution.name} ends on ${formattedEndDate}. Configure billing or deactivate the addon before expiry.`,
        tag: "PLAN_EXPIRY",
        recipientType: "SPECIFIC",
        deliveredTo: 1,
        recipients: {
          create: { institutionId: sub.institutionId },
        },
      },
    });

    const updatedAddons = {
      ...addons,
      smartBoardAi: {
        ...smartBoard,
        freeExpiry30DayAlertSent: true,
      },
    };

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { addons: updatedAddons },
    });

    logAudit("SMARTBOARD_FREE_EXPIRY_ALERT_SENT", {
      actorRole: "SYSTEM",
      institutionId: sub.institutionId,
      details: `Smart Board + AI free expiry alert sent (30 days remaining).`,
      metadata: {
        freeEndDate: smartBoard.freeEndDate,
      },
      category: "SYSTEM",
      severity: "INFO",
    });
  }
}

export function startAddonCron() {
  cron.schedule(
    "45 3 * * *",
    async () => {
      console.log(`[Addon Cron] Running smart-board free expiry checks at ${new Date().toISOString()}`);
      try {
        await runSmartBoardFreeExpiryAlerts();
        await recordCronRun("addon-smartboard-expiry", true);
      } catch (err) {
        console.error("[Addon Cron] Smart-board free expiry run failed:", err);
        await recordCronRun("addon-smartboard-expiry", false, err instanceof Error ? err.message : "Unknown error");
      }
    },
    { timezone: "Asia/Kolkata" }
  );

  console.log("[Addon Cron] Addon cron scheduled (daily 9:15 AM IST)");
}
