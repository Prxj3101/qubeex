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
  PRO:    15_000_000,
  TRIAL:   2_000_000,
};

// The institution's monthly AI token allowance, derived from its plan plus
// any active extraAiTokens addon. This is the single source of truth for
// the token pool ceiling — Redis only tracks the running "used" counter,
// never the limit itself.

// Smart Board + AI is free-billing for its first year (see buildSmartBoardFreeAddon
// in superadmin.service.ts), but its AI usage is still capped — it draws from
// this fixed allowance on top of the plan's base pool, whether the addon is
// still in its free period or has since been paid for. Locked addons (active:
// false) contribute nothing.
export const SMART_BOARD_AI_TOKEN_ALLOWANCE = 500_000;

export const getAiTokenLimit = async (institutionId: string): Promise<number> => {
  const subscription = await prisma.subscription.findUnique({
    where: { institutionId },
    include: { plan: { select: { name: true } } },
  });
  const isTrial = !subscription || subscription.status === "TRIAL";
  const planName: PlanName = isTrial ? "TRIAL" : ((subscription?.plan?.name as PlanName) ?? "BASIC");

  const addons = (subscription?.addons && typeof subscription.addons === "object" && !Array.isArray(subscription.addons))
    ? subscription.addons as Record<string, unknown>
    : {};
  const extraAiTokens = (addons.extraAiTokens as Array<{ active?: boolean; tokensPerMonth?: number }> ?? [])
    .filter((t) => t.active)
    .reduce((sum, t) => sum + (t.tokensPerMonth ?? 0), 0);
  const smartBoardAddon = addons.smartBoardAi as { active?: boolean } | undefined;
  const smartBoardAiTokens = smartBoardAddon?.active ? SMART_BOARD_AI_TOKEN_ALLOWANCE : 0;

  return PLAN_AI_TOKENS[planName] + extraAiTokens + smartBoardAiTokens;
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
  activatedAt?: string; // first month it's billed for is prorated from this date
};

type SmartBoardAddon = FeatureAddon & {
  isInFreePeriod?: boolean;
  freeEndDate?: string;
  lockedAt?: string; // set when the free year ends with no payment configured
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
  activatedAt?: string; // first month it's billed for is prorated from this date
};

type SubscriptionAddons = {
  smartBoardAi?: SmartBoardAddon;
  performanceInsightsAndAnalytics?: FeatureAddon;
  timetableAutoScheduling?: FeatureAddon;
  extraStorage?: ExtraStorageAddon[];
  extraAiTokens?: AiTokenAddon[];
};

type PlanOption = "NORMAL" | "COMMITTED";

// Mirrors the superadmin UI's PLAN_BASE (institution-detail.constants.ts) —
// keep these two in sync. Marginal billing: first VOLUME_THRESHOLD users at
// baseRate, users beyond that at the lower marginalRate. COMMITTED plans get
// COMMITTED_DISCOUNT off the resulting bill.
const PLAN_BASE_RATES: Record<PlanName, { baseRate: number; marginalRate: number }> = {
  BASIC: { baseRate: 29, marginalRate: 24 },
  PRO:   { baseRate: 39, marginalRate: 33 },
  TRIAL: { baseRate: 0,  marginalRate: 0  },
};

export const VOLUME_THRESHOLD = 1500;
export const COMMITTED_DISCOUNT = 0.15;

/** Total monthly bill for a plan/user-count/planOption — matches the frontend's getMarginalMonthlyBill exactly. */
export const getMarginalBill = (planName: PlanName, userCount: number, planOption: PlanOption = "NORMAL"): number => {
  const { baseRate, marginalRate } = PLAN_BASE_RATES[planName] ?? PLAN_BASE_RATES.BASIC;
  const billableUsers = Math.max(200, userCount);
  let bill: number;
  if (billableUsers <= VOLUME_THRESHOLD) {
    bill = billableUsers * baseRate;
  } else {
    bill = VOLUME_THRESHOLD * baseRate + (billableUsers - VOLUME_THRESHOLD) * marginalRate;
  }
  if (planOption === "COMMITTED") bill = Math.round(bill * (1 - COMMITTED_DISCOUNT));
  return bill;
};

/** Effective blended per-user rate for display — matches the frontend's getEffectiveRate. */
export const getEffectiveRate = (planName: PlanName, userCount: number, planOption: PlanOption = "NORMAL"): number => {
  const billableUsers = Math.max(200, userCount);
  const bill = getMarginalBill(planName, userCount, planOption);
  return Math.round((bill / billableUsers) * 100) / 100;
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

// Single reused proration primitive — every billing flow (base plan, addons,
// mid-month reactivation) counts prorated days this same way: if the
// reference date falls in the billing month, bill from that day through
// month-end; otherwise the full month applies (steady-state).
const getActiveDaysForMonth = (billingDate: Date, referenceDate: Date | null): number => {
  const daysInMonth = getDaysInMonth(billingDate);
  if (!referenceDate || !isSameBillingMonth(billingDate, referenceDate)) return daysInMonth;
  return daysInMonth - referenceDate.getDate() + 1;
};

/** Prorates a full-month amount down to the billable days remaining, given a reference date (activation/reactivation/addon-start). */
export const prorateForMonth = (fullMonthAmount: number, billingDate: Date, referenceDate: Date | null): number => {
  const daysInMonth = getDaysInMonth(billingDate);
  const activeDays = getActiveDaysForMonth(billingDate, referenceDate);
  return Math.round((fullMonthAmount / daysInMonth) * activeDays);
};

/** The date proration should count from for a subscription's base-plan bill this month:
 *  whichever is later of the original activation or a mid-month reactivation. */
export const getBillingReferenceDate = (activationDate: Date | null, lastResumedAt: Date | null): Date | null => {
  if (!activationDate) return lastResumedAt;
  if (!lastResumedAt) return activationDate;
  return lastResumedAt > activationDate ? lastResumedAt : activationDate;
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

      const freePeriodJustExpired = smartBoard.isInFreePeriod && freeEnd && billingDate > freeEnd;
      if (freePeriodJustExpired) {
        // No billingCycle/amount configured means the institution never paid to
        // continue — lock the addon rather than silently keep it free forever.
        const hasBeenPriced = !!smartBoard.billingCycle && Number(smartBoard.amount ?? 0) > 0;
        if (!hasBeenPriced) {
          updatedAddons = {
            ...addons,
            smartBoardAi: {
              ...smartBoard,
              active: false,
              isInFreePeriod: false,
              lockedAt: billingDate.toISOString(),
            },
          };
          items.push({
            label: ADDON_LABELS[key],
            desc: "First-year free period ended — addon locked until reactivated with payment",
            amount: 0,
            type: "metadata",
          });
          continue;
        }
        updatedAddons = {
          ...addons,
          smartBoardAi: { ...smartBoard, isInFreePeriod: false },
        };
      }
    }

    const fullAmount = Number(addon.amount ?? 0);
    if (fullAmount <= 0) continue;
    const activatedAt = addon.activatedAt ? new Date(addon.activatedAt) : null;
    const amount = prorateForMonth(fullAmount, billingDate, activatedAt);
    if (amount <= 0) continue;
    items.push({
      label: ADDON_LABELS[key],
      desc: activatedAt && isSameBillingMonth(billingDate, activatedAt)
        ? `${addon.billingCycle ?? "MONTHLY"} addon charge (prorated, activated ${activatedAt.toDateString()})`
        : `${addon.billingCycle ?? "MONTHLY"} addon charge`,
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
    const fullTokenAmount = Number(tokenAddon.monthlyAmount ?? 0);
    if (fullTokenAmount <= 0) continue;
    const tokenActivatedAt = tokenAddon.activatedAt ? new Date(tokenAddon.activatedAt) : null;
    const amount = prorateForMonth(fullTokenAmount, billingDate, tokenActivatedAt);
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
    const fullMonthAmount = getMarginalBill(planName, userSnapshot, sub.planOption);
    const effectiveRate = getEffectiveRate(planName, userSnapshot, sub.planOption);
    const billingReferenceDate = getBillingReferenceDate(sub.activationDate, sub.lastResumedAt);
    const activeDays = getActiveDaysForMonth(billingDate, billingReferenceDate);
    const baseAmount = prorateForMonth(fullMonthAmount, billingDate, billingReferenceDate);

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
        desc: `${billedUsers} billed users (${userSnapshot} actual snapshot, ${sub.planOption.toLowerCase()}) x Rs.${effectiveRate}/user (effective) x ${activeDays}/${daysInMonth} days`,
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
        effectiveRate,
        planOption: sub.planOption,
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
      subscription: { select: { planOption: true } },
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
  const planOption = institution.subscription?.planOption ?? "NORMAL";
  const basicBill = getMarginalBill("BASIC", actualUsers, planOption);
  const proBill = getMarginalBill("PRO", actualUsers, planOption);
  const billDifference = Math.max(0, proBill - basicBill);
  const daysInMonth = getDaysInMonth(upgradeDate);
  const remainingDays = getActiveDaysForMonth(upgradeDate, upgradeDate);
  const prorationAmount = prorateForMonth(billDifference, upgradeDate, upgradeDate);
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
          desc: `${billedUsers} billed users (${actualUsers} actual snapshot), Rs.${billDifference} monthly bill difference (${planOption.toLowerCase()}) x ${remainingDays}/${daysInMonth} days`,
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
      planOption,
      basicBill,
      proBill,
      billDifference,
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
        // Don't touch lastResumedAt here — this is recovery from a non-payment
        // auto-suspend, not a voluntary billing pause. The institution was in
        // active use all month; resetting lastResumedAt would wrongly make
        // getBillingReferenceDate() prorate this month's bill from today
        // instead of billing the full month.
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
