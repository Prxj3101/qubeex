// ── Income tax (TDS on salary, section 192) ─────────────────────────────────
// Pure functions, no DB. Money in paise.
//
// Each month the employer estimates the whole financial year's salary
// (April-March): what was already paid this FY + this month + the rest of the
// year at the current salary. Tax on that, minus TDS already deducted, spread
// evenly over the months left (including this one) = this month's TDS.
//
// Rules for FY 2026-27 (unchanged from FY 2025-26):
//   New regime: 0-4L nil, 4-8L 5%, 8-12L 10%, 12-16L 15%, 16-20L 20%, 20-24L 25%, above 24L 30%.
//               Standard deduction ₹75,000. 87A: no tax up to ₹12L taxable, with marginal relief.
//   Old regime: 0-2.5L nil, 2.5-5L 5%, 5-10L 20%, above 10L 30%. Standard deduction ₹50,000,
//               professional tax, 80C (incl. employee PF, max ₹1.5L), 80D, HRA exemption, others.
//               87A: no tax up to ₹5L taxable.
//   4% health & education cess on tax (+ surcharge above ₹50L).
// Age-based old-regime slabs (60+ / 80+) are not handled.

const L = 100_000_00; // ₹1 lakh in paise

export type TaxRegime = "NEW" | "OLD";

export interface TaxDeclaration {
  sec80C?: number; // paise, investments other than employee PF (PPF, LIC, ELSS, tuition fees...)
  sec80D?: number; // health insurance
  hraExempt?: number; // yearly HRA exemption worked out by the school
  otherDeductions?: number; // 80E, 80G, 80TTA, home-loan interest...
  prevEmployerIncome?: number; // salary from a previous job earlier this FY
  prevEmployerTds?: number; // TDS already cut by that employer
  tdsBeforeQubeex?: number; // TDS this school cut this FY in months not in QubeEx (before it started using it)
}

const NEW_SLABS: [number, number][] = [[4 * L, 0], [8 * L, 5], [12 * L, 10], [16 * L, 15], [20 * L, 20], [24 * L, 25], [Infinity, 30]];
const OLD_SLABS: [number, number][] = [[2.5 * L, 0], [5 * L, 5], [10 * L, 20], [Infinity, 30]];

function slabTax(income: number, slabs: [number, number][]): number {
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of slabs) {
    if (income <= lower) break;
    tax += ((Math.min(income, upper) - lower) * rate) / 100;
    lower = upper;
  }
  return tax;
}

function surchargeRate(income: number, regime: TaxRegime): number {
  if (income > 500 * L) return regime === "OLD" ? 37 : 25;
  if (income > 200 * L) return 25;
  if (income > 100 * L) return 15;
  if (income > 50 * L) return 10;
  return 0;
}

/** Yearly tax (incl. rebate, surcharge, 4% cess) on taxable income, in paise, rounded to the rupee. */
export function annualTax(taxable: number, regime: TaxRegime): number {
  if (taxable <= 0) return 0;
  let tax = slabTax(taxable, regime === "NEW" ? NEW_SLABS : OLD_SLABS);
  if (regime === "NEW") {
    if (taxable <= 12 * L) tax = 0;
    else tax = Math.min(tax, taxable - 12 * L); // marginal relief just above ₹12L
  } else if (taxable <= 5 * L) {
    tax = Math.max(0, tax - 12_500_00);
  }
  tax += (tax * surchargeRate(taxable, regime)) / 100; // (no marginal relief on surcharge)
  tax += (tax * 4) / 100; // cess
  return Math.round(tax / 100) * 100;
}

// April = 1 ... March = 12
export function fyMonthIndex(month: string): number {
  const m = Number(month.slice(5, 7));
  return m >= 4 ? m - 3 : m + 9;
}
export function fyStartYear(month: string): number {
  const y = Number(month.slice(0, 4));
  return Number(month.slice(5, 7)) >= 4 ? y : y - 1;
}
/** First and last "YYYY-MM" of the financial year that `month` falls in. */
export function fyRange(month: string): { from: string; to: string } {
  const y = fyStartYear(month);
  return { from: `${y}-04`, to: `${y + 1}-03` };
}

export interface TdsInput {
  month: string;
  regime: TaxRegime;
  hasPan: boolean;
  declaration: TaxDeclaration;
  // This month (from the salary calculation, before TDS)
  currentTaxable: number; // gross earned this month (after LOP) incl. bonus
  currentPt: number;
  currentEmployeePf: number;
  // The rest of the year is estimated at the normal monthly salary
  normalMonthlyGross: number;
  normalMonthlyPt: number;
  normalMonthlyEmployeePf: number;
  // Earlier months of this FY with this school (published payslips)
  pastTaxable: number;
  pastPt: number;
  pastEmployeePf: number;
  pastTds: number;
  // Earlier months of this FY (after joining) with no payslip in QubeEx, e.g. the
  // school started using QubeEx mid-year: assumed paid at the normal salary.
  assumedPastMonths?: number;
}

export interface TdsResult {
  monthlyTds: number; // paise, whole rupees
  info: {
    regime: TaxRegime;
    estimatedAnnualIncome: number;
    deductions: number; // standard deduction + chapter VI-A etc. used
    taxableIncome: number;
    annualTax: number;
    alreadyDeducted: number;
    monthsLeft: number; // including this month
    noPanRule: boolean; // 20% minimum applied because PAN is missing
    assumedPastMonths: number;
  };
}

export function computeMonthlyTds(i: TdsInput): TdsResult {
  const d = i.declaration;
  const monthsLeft = 12 - fyMonthIndex(i.month) + 1; // including this month
  const futureMonths = monthsLeft - 1;

  const assumed = Math.max(0, i.assumedPastMonths ?? 0);
  const income = i.pastTaxable + i.currentTaxable + i.normalMonthlyGross * (futureMonths + assumed) + (d.prevEmployerIncome ?? 0);

  let deductions: number;
  if (i.regime === "NEW") {
    deductions = 75_000_00;
  } else {
    const pt = i.pastPt + i.currentPt + i.normalMonthlyPt * (futureMonths + assumed);
    const pf = i.pastEmployeePf + i.currentEmployeePf + i.normalMonthlyEmployeePf * (futureMonths + assumed);
    const c80 = Math.min(1.5 * L, pf + (d.sec80C ?? 0));
    deductions = 50_000_00 + Math.min(pt, 2_500_00) + c80 + (d.sec80D ?? 0) + (d.hraExempt ?? 0) + (d.otherDeductions ?? 0);
  }
  const taxable = Math.max(0, Math.round((income - deductions) / 1000) * 1000); // rounded to ₹10 (sec 288A)
  const tax = annualTax(taxable, i.regime);
  const already = i.pastTds + (d.prevEmployerTds ?? 0) + (d.tdsBeforeQubeex ?? 0);

  let monthly = Math.max(0, (tax - already) / monthsLeft);
  let noPanRule = false;
  // Section 206AA: without a PAN, TDS is at least 20% (when any tax is due).
  if (!i.hasPan && tax > 0) {
    const floor = (i.currentTaxable * 20) / 100;
    if (floor > monthly) { monthly = floor; noPanRule = true; }
  }
  const monthlyTds = Math.round(monthly / 100) * 100;

  return {
    monthlyTds,
    info: { regime: i.regime, estimatedAnnualIncome: income, deductions, taxableIncome: taxable, annualTax: tax, alreadyDeducted: already, monthsLeft, noPanRule, assumedPastMonths: assumed },
  };
}
