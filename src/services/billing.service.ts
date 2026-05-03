import { prisma } from "../utils/prisma";
import { logAudit } from "./audit.service";

// ─── Pricing table (mirrors frontend PRICING constant) ──────────────────────

const TIERS: Record<string, Record<string, { licence: number; tiers: { min: number; max: number; rate: number }[] }>> = {
  SCHOOL: {
    BASIC: { licence: 39999, tiers: [{ min: 200, max: 1499, rate: 20 }, { min: 1500, max: Infinity, rate: 17 }] },
    PRO:   { licence: 69999, tiers: [{ min: 200, max: 1499, rate: 25 }, { min: 1500, max: Infinity, rate: 22 }] },
  },
  COLLEGE: {
    BASIC: { licence: 59999, tiers: [{ min: 200, max: 1499, rate: 30 }, { min: 1500, max: Infinity, rate: 27 }] },
    PRO:   { licence: 89999, tiers: [{ min: 200, max: 1499, rate: 35 }, { min: 1500, max: Infinity, rate: 32 }] },
  },
  COACHING: {
    BASIC: { licence: 39999, tiers: [{ min: 200, max: 1499, rate: 20 }, { min: 1500, max: Infinity, rate: 17 }] },
    PRO:   { licence: 69999, tiers: [{ min: 200, max: 1499, rate: 25 }, { min: 1500, max: Infinity, rate: 22 }] },
  },
};

function getRate(instType: string, planName: string, userCount: number): number {
  const tiers = TIERS[instType]?.[planName]?.tiers ?? TIERS.SCHOOL.BASIC.tiers;
  return tiers.find((t) => userCount >= t.min && userCount <= t.max)?.rate ?? tiers[0].rate;
}

// ─── Generate monthly bills for all ACTIVE / PAUSED subscriptions ────────────

export const generateMonthlyBills = async () => {
  const now = new Date();
  const billingMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Fetch all billable subscriptions (ACTIVE or PAUSED)
  const subscriptions = await prisma.subscription.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] } },
    include: {
      plan: true,
      institution: {
        include: { _count: { select: { users: true } } },
      },
    },
  });

  let generated = 0;
  let skipped = 0;

  for (const sub of subscriptions) {
    // Skip if a bill for this month already exists
    const existing = await prisma.bill.findFirst({
      where: { institutionId: sub.institutionId, type: "MONTHLY", billingMonth },
    });
    if (existing) { skipped++; continue; }

    const inst = sub.institution;
    const planName = sub.plan.name;
    if (planName === "TRIAL") { skipped++; continue; }

    const userCount     = inst._count.users;
    const billedUsers   = Math.max(200, userCount);
    const rate          = getRate(inst.type, planName, billedUsers);
    const fullAmount    = billedUsers * rate;

    // PAUSED institutions billed at 50%
    const isPaused      = sub.status === "PAUSED";
    const baseAmount    = isPaused ? Math.round(fullAmount * 0.5) : fullAmount;
    const discountAmount = isPaused ? Math.round(fullAmount * 0.5) : 0;
    const totalAmount   = baseAmount;

    const dueDate = new Date(now.getFullYear(), now.getMonth() + 1, 7); // 7th of next month

    const items: { label: string; desc: string; amount: number; type: string }[] = [
      {
        label: "Monthly User Bill",
        desc: `${billedUsers} users × ₹${rate}/user`,
        amount: fullAmount,
        type: "base",
      },
    ];

    if (isPaused) {
      items.push({
        label: "Pause Discount (50%)",
        desc: "50% billing applied during pause period",
        amount: -discountAmount,
        type: "discount",
      });
    }

    await prisma.bill.create({
      data: {
        institutionId: sub.institutionId,
        type: "MONTHLY",
        billingMonth,
        userCount: billedUsers,
        baseAmount: fullAmount,
        discountAmount,
        addonAmount: 0,
        totalAmount,
        items,
        dueDate,
      },
    });

    generated++;
  }

  await logAudit("MONTHLY_BILLS_GENERATED", {
    details: `Monthly billing for ${billingMonth}: ${generated} bills created, ${skipped} skipped`,
    metadata: { billingMonth, generated, skipped },
  });

  console.log(`[Billing] ${billingMonth}: ${generated} bills generated, ${skipped} skipped`);
  return { billingMonth, generated, skipped };
};
