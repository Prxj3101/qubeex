import { prisma } from "../utils/prisma";
import { logAudit } from "./audit.service";
import { sendMonthlyBillEmail } from "./email.service";
import { ensurePaymentLink } from "./razorpay.service";
import { delCache } from "../utils/cache";

type PlanName = "BASIC" | "PRO" | "TRIAL";
type InstitutionType = "SCHOOL" | "COLLEGE" | "COACHING";
type BillingCycle = "MONTHLY" | "YEARLY";

export const PLAN_AI_TOKENS: Record<PlanName, number> = {
  BASIC:  10_000_000,
  PRO:    10_000_000,
  TRIAL:   2_000_000,
};


type BillItem = {
  label: string;
  desc: string;
  amount: number;
  type: "base" | "addon" | "discount" | "metadata";
};

type FeatureAddon = {
  active?: boolean;
  billingCycle?: BillingCycle;
  amount?: number | null;
};

type SmartBoardAddon = FeatureAddon & {
  isInFreePeriod?: boolean;
  freeEndDate?: string;
};

type ExtraStorageAddon = {
  active?: boolean;
  gbPurchased?: number;
  oneTimeAmount?: number;
  purchasedAt?: string;
};

type AiTokenAddon = {
  active?: boolean;
  tokensPerMonth?: number;
  monthlyAmount?: number;
};

type SubscriptionAddons = {
  smartBoardAi?: SmartBoardAddon;
  performanceInsightsAndAnalytics?: FeatureAddon;
  timetableAutoScheduling?: FeatureAddon;
  extraStorage?: ExtraStorageAddon[];
  extraAiTokens?: AiTokenAddon[];
};

const PER_USER_RATES: Record<PlanName, { min: number; max: number; rate: number }[]> = {
  BASIC: [
    { min: 200, max: 1499, rate: 20 },
    { min: 1500, max: Number.POSITIVE_INFINITY, rate: 17 },
  ],
  PRO: [
    { min: 200, max: 1499, rate: 25 },
    { min: 1500, max: Number.POSITIVE_INFINITY, rate: 22 },
  ],
  TRIAL: [{ min: 0, max: Number.POSITIVE_INFINITY, rate: 0 }],
};

const ADDON_LABELS: Record<keyof Pick<SubscriptionAddons, "smartBoardAi" | "performanceInsightsAndAnalytics" | "timetableAutoScheduling">, string> = {
  smartBoardAi: "Smart Board Screen with AI",
  performanceInsightsAndAnalytics: "Performance Insights & Analytics",
  timetableAutoScheduling: "Timetable Auto-Scheduling",
};

const toBillingMonth = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

const getDaysInMonth = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

const isSameBillingMonth = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

export const getRate = (planName: PlanName, userCount: number): number => {
  const tiers = PER_USER_RATES[planName] ?? PER_USER_RATES.BASIC;
  return tiers.find((tier) => userCount >= tier.min && userCount <= tier.max)?.rate ?? tiers[0].rate;
};

const getActiveDaysForMonth = (billingDate: Date, activationDate: Date | null): number => {
  const daysInMonth = getDaysInMonth(billingDate);
  if (!activationDate || !isSameBillingMonth(billingDate, activationDate)) return daysInMonth;
  return daysInMonth - activationDate.getDate() + 1;
};

const normalizeAddons = (addons: unknown): SubscriptionAddons => {
  if (!addons || typeof addons !== "object" || Array.isArray(addons)) return {};
  return addons as SubscriptionAddons;
};

const isDateInBillingMonth = (value: string | undefined, billingDate: Date) => {
  if (!value) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return isSameBillingMonth(parsed, billingDate);
};

const getAddonItems = (addons: SubscriptionAddons, billingDate: Date): { items: BillItem[]; updatedAddons?: SubscriptionAddons } => {
  const items: BillItem[] = [];
  let updatedAddons: SubscriptionAddons | undefined;

  const featureAddonKeys: Array<keyof typeof ADDON_LABELS> = [
    "smartBoardAi",
    "performanceInsightsAndAnalytics",
    "timetableAutoScheduling",
  ];

  for (const key of featureAddonKeys) {
    const addon = addons[key];
    if (!addon?.active) continue;

    if (key === "smartBoardAi") {
      const smartBoard = addon as SmartBoardAddon;
      const freeEnd = smartBoard.freeEndDate ? new Date(smartBoard.freeEndDate) : null;
      const isInFreePeriod = smartBoard.isInFreePeriod && freeEnd && billingDate <= freeEnd;
      if (isInFreePeriod) {
        items.push({
          label: ADDON_LABELS[key],
          desc: `First-year free addon active until ${freeEnd.toISOString()}`,
          amount: 0,
          type: "metadata",
        });
        continue;
      }

      if (smartBoard.isInFreePeriod && freeEnd && billingDate > freeEnd) {
        updatedAddons = {
          ...addons,
          smartBoardAi: {
            ...smartBoard,
            isInFreePeriod: false,
          },
        };
      }
    }

    const amount = Number(addon.amount ?? 0);
    if (amount <= 0) continue;
    items.push({
      label: ADDON_LABELS[key],
      desc: `${addon.billingCycle ?? "MONTHLY"} addon charge`,
      amount,
      type: "addon",
    });
  }

  for (const storage of addons.extraStorage ?? []) {
    if (!storage.active || !isDateInBillingMonth(storage.purchasedAt, billingDate)) continue;
    const amount = Number(storage.oneTimeAmount ?? 0);
    if (amount <= 0) continue;
    items.push({
      label: "Extra Storage Add-On",
      desc: `${storage.gbPurchased ?? 0} GB one-time storage purchase`,
      amount,
      type: "addon",
    });
  }

  for (const tokenAddon of addons.extraAiTokens ?? []) {
    if (!tokenAddon.active) continue;
    const amount = Number(tokenAddon.monthlyAmount ?? 0);
    if (amount <= 0) continue;
    items.push({
      label: "Extra AI Tokens Add-On",
      desc: `${(tokenAddon.tokensPerMonth ?? 0).toLocaleString("en-IN")} extra tokens/month`,
      amount,
      type: "addon",
    });
  }

  return { items, updatedAddons };
};

const getInstitutionAdminEmail = async (institutionId: string) => {
  const admin = await prisma.user.findFirst({
    where: { institutionId, role: "ADMIN" },
    select: { email: true },
  });
  return admin?.email ?? null;
};

export const generateMonthlyBills = async (billingDate = new Date()) => {
  const billingMonth = toBillingMonth(billingDate);
  const daysInMonth = getDaysInMonth(billingDate);

  const subscriptions = await prisma.subscription.findMany({
    where: { status: "ACTIVE" },
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
    const planName = sub.plan.name as PlanName;
    if (planName === "TRIAL" || !sub.activationDate) {
      skipped++;
      continue;
    }

    const existing = await prisma.bill.findFirst({
      where: { institutionId: sub.institutionId, type: "MONTHLY", billingMonth },
    });
    if (existing) {
      skipped++;
      continue;
    }

    const userSnapshot = sub.institution._count.users;
    const billedUsers = Math.max(200, userSnapshot);
    const rate = getRate(planName, billedUsers);
    const activeDays = getActiveDaysForMonth(billingDate, sub.activationDate);
    const fullMonthAmount = billedUsers * rate;
    const baseAmount = Math.round((fullMonthAmount / daysInMonth) * activeDays);

    const addons = normalizeAddons(sub.addons);
    const { items: addonItems, updatedAddons } = getAddonItems(addons, billingDate);
    const addonAmount = addonItems
      .filter((item) => item.type === "addon")
      .reduce((sum, item) => sum + item.amount, 0);
    const totalAmount = Math.max(0, baseAmount + addonAmount);
    const dueDate = new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, 7);

    const items: BillItem[] = [
      {
        label: "Monthly User Bill",
        desc: `${billedUsers} billed users (${userSnapshot} actual snapshot) x Rs.${rate}/user x ${activeDays}/${daysInMonth} days`,
        amount: baseAmount,
        type: "base",
      },
      ...addonItems,
    ];

    const bill = await prisma.bill.create({
      data: {
        institutionId: sub.institutionId,
        type: "MONTHLY",
        billingMonth,
        userCount: billedUsers,
        baseAmount,
        discountAmount: 0,
        addonAmount,
        totalAmount,
        items,
        dueDate,
      },
    });

    if (updatedAddons) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { addons: updatedAddons },
      });
    }

    const adminEmail = await getInstitutionAdminEmail(sub.institutionId);
    if (adminEmail) {
      ensurePaymentLink(bill.id)
        .then(({ linkUrl }) =>
          sendMonthlyBillEmail({
            to: adminEmail,
            institutionName: sub.institution.name,
            billingMonth,
            totalAmount,
            dueDate,
            billId: bill.id,
            paymentLinkUrl: linkUrl,
          })
        )
        .catch((err) => console.error("Monthly bill email/payment-link failed:", err.message));
    }

    logAudit("MONTHLY_BILL_GENERATED", {
      actorRole: "SYSTEM",
      institutionId: sub.institutionId,
      details: `Monthly bill generated for ${sub.institution.name} (${billingMonth})`,
      metadata: {
        billId: bill.id,
        billingMonth,
        userSnapshot,
        billedUsers,
        rate,
        activeDays,
        daysInMonth,
        addonAmount,
        totalAmount,
        adminEmail,
      },
      category: "BILLING",
      severity: "INFO",
    });

    generated++;
  }

  logAudit("MONTHLY_BILLS_GENERATED", {
    actorRole: "SYSTEM",
    details: `Monthly billing for ${billingMonth}: ${generated} bills created, ${skipped} skipped`,
    metadata: { billingMonth, generated, skipped },
    category: "BILLING",
    severity: "INFO",
  });

  console.log(`[Billing] ${billingMonth}: ${generated} bills generated, ${skipped} skipped`);
  return { billingMonth, generated, skipped };
};

export const autoDeactivateOverdueInstitutions = async (runDate = new Date()) => {
  const overdueBills = await prisma.bill.findMany({
    where: {
      type: "MONTHLY",
      status: "PENDING",
      dueDate: { lt: runDate },
      institution: {
        subscription: {
          status: "ACTIVE",
        },
      },
    },
    include: {
      institution: {
        include: { subscription: true },
      },
    },
  });

  let deactivated = 0;
  const processedInstitutionIds = new Set<string>();

  for (const bill of overdueBills) {
    if (processedInstitutionIds.has(bill.institutionId)) continue;
    processedInstitutionIds.add(bill.institutionId);

    await prisma.$transaction([
      prisma.subscription.update({
        where: { institutionId: bill.institutionId },
        data: { status: "EXPIRED", paymentStatus: "PENDING" },
      }),
      prisma.institution.update({
        where: { id: bill.institutionId },
        data: { status: "SUSPENDED" },
      }),
    ]);

    await delCache(`inst:access:${bill.institutionId}`);

    logAudit("INSTITUTION_AUTO_DEACTIVATED_NON_PAYMENT", {
      actorRole: "SYSTEM",
      institutionId: bill.institutionId,
      details: `Institution auto-deactivated for unpaid bill ${bill.id}`,
      metadata: {
        billId: bill.id,
        dueDate: bill.dueDate,
        totalAmount: bill.totalAmount,
      },
      category: "BILLING",
      severity: "CRITICAL",
    });

    deactivated++;
  }

  console.log(`[Billing] Auto-deactivation run: ${deactivated} institution(s) deactivated`);
  return { deactivated };
};

export const generateUpgradeProrationBill = async (institutionId: string, upgradeDate = new Date()) => {
  const institution = await prisma.institution.findUnique({
    where: { id: institutionId },
    include: {
      _count: { select: { users: true } },
    },
  });
  if (!institution) return null;

  const billingMonth = toBillingMonth(upgradeDate);
  const existing = await prisma.bill.findFirst({
    where: { institutionId, type: "UPGRADE_PRORATION", billingMonth },
  });
  if (existing) return existing;

  const actualUsers = institution._count.users;
  const billedUsers = Math.max(200, actualUsers);
  const basicRate = getRate("BASIC", billedUsers);
  const proRate = getRate("PRO", billedUsers);
  const rateDifference = Math.max(0, proRate - basicRate);
  const daysInMonth = getDaysInMonth(upgradeDate);
  const remainingDays = daysInMonth - upgradeDate.getDate() + 1;
  const prorationAmount = Math.round((billedUsers * rateDifference / daysInMonth) * remainingDays);
  const upgradeFixedCharge = 5000;
  const baseAmount = prorationAmount;
  const totalAmount = prorationAmount + upgradeFixedCharge;

  const dueDate = new Date(upgradeDate);
  dueDate.setDate(dueDate.getDate() + 7);

  const bill = await prisma.bill.create({
    data: {
      institutionId,
      type: "UPGRADE_PRORATION",
      billingMonth,
      userCount: billedUsers,
      baseAmount,
      totalAmount,
      items: [
        {
          label: "Basic to Pro Rate Proration",
          desc: `${billedUsers} billed users (${actualUsers} actual snapshot) x Rs.${rateDifference}/user difference x ${remainingDays}/${daysInMonth} days`,
          amount: prorationAmount,
          type: "base",
        },
        {
          label: "PRO Upgrade Charge",
          desc: "One-time fixed upgrade fee",
          amount: upgradeFixedCharge,
          type: "addon",
        },
      ],
      dueDate,
    },
  });

  const adminEmail = await getInstitutionAdminEmail(institutionId);
  if (adminEmail) {
    ensurePaymentLink(bill.id)
      .then(({ linkUrl }) =>
        sendMonthlyBillEmail({
          to: adminEmail,
          institutionName: institution.name,
          billingMonth: `${billingMonth} upgrade proration`,
          totalAmount,
          dueDate,
          billId: bill.id,
          paymentLinkUrl: linkUrl,
        })
      )
      .catch((err) => console.error("Upgrade proration email/payment-link failed:", err.message));
  }

  logAudit("UPGRADE_PRORATION_BILL_GENERATED", {
    actorRole: "SYSTEM",
    institutionId,
    details: `Upgrade proration bill generated for ${institution.name}`,
    metadata: {
      billId: bill.id,
      billingMonth,
      billedUsers,
      actualUsers,
      basicRate,
      proRate,
      rateDifference,
      remainingDays,
      daysInMonth,
      prorationAmount,
      upgradeFixedCharge,
      totalAmount,
    },
    category: "BILLING",
    severity: "INFO",
  });

  return bill;
};

export const markBillPaid = async (
  billId: string,
  razorpayPaymentId?: string,
  paymentMethod?: string
): Promise<{ reactivated: boolean }> => {
  const bill = await prisma.bill.findUnique({
    where: { id: billId },
    include: { institution: { include: { subscription: true } } },
  });
  if (!bill) throw new Error(`Bill ${billId} not found`);

  await prisma.bill.update({
    where: { id: billId },
    data: {
      status: "PAID",
      paidAt: new Date(),
      ...(razorpayPaymentId ? { razorpayPaymentId } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
    },
  });

  const pendingDues = await prisma.bill.count({
    where: { institutionId: bill.institutionId, status: "PENDING" },
  });

  let reactivated = false;
  if (pendingDues === 0 && bill.institution.subscription?.status === "EXPIRED") {
    await prisma.$transaction([
      prisma.subscription.update({
        where: { institutionId: bill.institutionId },
        data: { status: "ACTIVE", paymentStatus: "PAID" },
      }),
      prisma.institution.update({
        where: { id: bill.institutionId },
        data: { status: "ACTIVE" },
      }),
    ]);
    reactivated = true;
  }

  logAudit("BILL_MARKED_PAID", {
    actorRole: "SYSTEM",
    institutionId: bill.institutionId,
    category: "BILLING",
    severity: "INFO",
    details: `Bill ${billId} marked PAID${razorpayPaymentId ? ` via Razorpay ${razorpayPaymentId}` : " manually"}`,
    metadata: { billId, razorpayPaymentId, reactivated },
  });

  return { reactivated };
};
