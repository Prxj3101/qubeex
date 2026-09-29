// Pure salary calculation engine for payroll — no DB access, so it is easy to
// unit test and is shared by run creation, recalculation and previews.
//
// Money is ALWAYS integer paise (₹1 = 100). Percentages are basis points
// (4000 = 40%). Every intermediate amount is rounded to the nearest paisa.

export type ComponentType = "EARNING" | "DEDUCTION";
export type CalcType = "FIXED" | "PERCENT_OF_BASIC";
export type DayBasis = "CALENDAR" | "FIXED_30" | "FIXED_26";

export interface CalcComponent {
  id: string;
  name: string;
  type: ComponentType;
  calcType: CalcType;
  isBasic: boolean;
  lopApplicable: boolean;
  pfApplicable?: boolean; // counts towards PF wages (Basic always does)
  sortOrder: number;
}

// Provident Fund rules (from PayrollSettings). Rates in basis points (1200 = 12%).
// Pass it only when PF applies to this person (school has PF on + staff not excluded).
export interface PfConfig {
  ceiling: number; // paise, monthly wage ceiling (₹25,000 from 17 Sep 2026)
  capWages: boolean; // true: PF on min(PF wages, ceiling); false: on full PF wages
  employeeRate: number; // 1200
  employerRate: number; // 1200 (EPS + EPF together)
  epsRate: number; // 833, always on wages up to the ceiling
  edliRate: number; // 50
  adminRate: number; // 50
}

// One entry of a staff salary structure / template.
export interface StructureItem {
  componentId: string;
  value: number; // paise for FIXED, basis points for PERCENT_OF_BASIC
}

export interface Adjustment {
  label: string;
  type: ComponentType;
  amount: number; // paise
}

// ESI (from PayrollSettings). Pass only when ESI applies to this person.
export interface EsiConfig {
  wageLimit: number; // paise; covered when the normal monthly gross is up to this (₹21,000)
  employeeRate: number; // 75 = 0.75%
  employerRate: number; // 325 = 3.25%
}

// Professional Tax slab table (state-wise). The highest slab whose `from` is
// <= the month's gross applies; `febAmount` (if set) is used in February.
export interface PtSlab { from: number; amount: number; febAmount?: number | null } // paise
export interface PtConfig { slabs: PtSlab[] }

export interface CalcInput {
  month: string; // "YYYY-MM"
  items: StructureItem[];
  components: CalcComponent[];
  dayBasis: DayBasis;
  lopDays?: number; // loss-of-pay days, half days allowed
  joinedAt?: Date | null;
  exitDate?: Date | null;
  adjustments?: Adjustment[];
  pf?: PfConfig | null;
  esi?: EsiConfig | null;
  pt?: PtConfig | null;
}

export interface CalcLine {
  label: string;
  amount: number; // paise
}

export interface CalcResult {
  earnings: CalcLine[];
  deductions: CalcLine[];
  grossPay: number; // paise
  totalDeductions: number; // paise
  netPay: number; // paise
  daysInMonth: number;
  basisDays: number;
  employedDays: number; // calendar days of the month the person was on the rolls
  lopDays: number;
  paidDays: number; // basis days actually paid for LOP-applicable heads
  employer: CalcLine[]; // employer contributions (PF etc.) - part of cost, NOT deducted from pay
  pfWages: number; // paise, PF wages actually earned this month (0 when PF doesn't apply)
}

const round = (n: number): number => Math.round(n);

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function basisDaysFor(dayBasis: DayBasis, month: string): number {
  if (dayBasis === "FIXED_30") return 30;
  if (dayBasis === "FIXED_26") return 26;
  return daysInMonth(month);
}

// Calendar day number (1..daysInMonth) of a date inside `month`, or null if
// the date falls outside it. Uses the date's UTC calendar day, matching how
// dates are stored (midnight UTC for date-only inputs).
function dayInMonth(date: Date, month: string): number | null {
  const [y, m] = month.split("-").map(Number);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m) return null;
  return date.getUTCDate();
}

function monthStart(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}

function monthEnd(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
}

// How many calendar days of `month` the person was employed.
export function employedDaysInMonth(month: string, joinedAt?: Date | null, exitDate?: Date | null): number {
  const total = daysInMonth(month);
  if (joinedAt && joinedAt > monthEnd(month)) return 0;
  if (exitDate && exitDate < monthStart(month)) return 0;
  const firstDay = joinedAt ? dayInMonth(joinedAt, month) ?? 1 : 1;
  const lastDay = exitDate ? dayInMonth(exitDate, month) ?? total : total;
  return Math.max(0, lastDay - firstDay + 1);
}

export function calculateSalary(input: CalcInput): CalcResult {
  const dim = daysInMonth(input.month);
  const basisDays = basisDaysFor(input.dayBasis, input.month);
  const employedDays = employedDaysInMonth(input.month, input.joinedAt, input.exitDate);
  const employedFraction = dim > 0 ? employedDays / dim : 0;

  const lopDays = Math.max(0, input.lopDays ?? 0);
  // Days paid for LOP-applicable heads: the employed share of the basis,
  // minus LOP days, never below zero.
  const paidDays = Math.max(0, basisDays * employedFraction - lopDays);
  const lopFraction = basisDays > 0 ? Math.min(1, paidDays / basisDays) : 0;

  const byId = new Map(input.components.map((c) => [c.id, c]));
  const rows = input.items
    .map((it) => ({ item: it, comp: byId.get(it.componentId) }))
    .filter((r): r is { item: StructureItem; comp: CalcComponent } => !!r.comp)
    .sort((a, b) => a.comp.sortOrder - b.comp.sortOrder);

  // Full-month Basic (before any proration) drives PERCENT_OF_BASIC earnings.
  const basicRow = rows.find((r) => r.comp.isBasic && r.comp.type === "EARNING");
  const fullBasic = basicRow && basicRow.comp.calcType === "FIXED" ? basicRow.item.value : 0;

  const fullAmount = (r: { item: StructureItem; comp: CalcComponent }, basic: number): number =>
    r.comp.calcType === "PERCENT_OF_BASIC" ? round((basic * r.item.value) / 10000) : r.item.value;

  const prorate = (amount: number, lopApplicable: boolean): number =>
    round(amount * (lopApplicable ? lopFraction : employedFraction));

  // Earnings are shown for the days the person was on the rolls (joining /
  // leaving proration only). Unpaid leave is NOT hidden inside them: it is
  // shown as a separate "Loss of Pay" deduction, like a printed payslip.
  const earnings: CalcLine[] = [];
  let earnedBasic = 0; // Basic actually earned after LOP (drives % deductions like PF)
  let lopAmount = 0;
  let pfWages = 0; // earned (after LOP / proration) amounts of PF-applicable earnings
  let fullGross = 0; // normal full-month gross (for ESI eligibility)
  let earnedGross = 0; // gross actually earned this month after LOP / proration (ESI and PT wages)
  for (const r of rows.filter((x) => x.comp.type === "EARNING")) {
    const full = fullAmount(r, fullBasic);
    const shown = round(full * employedFraction);
    const afterLop = prorate(full, r.comp.lopApplicable);
    if (r === basicRow) earnedBasic = afterLop;
    if (r.comp.lopApplicable) lopAmount += shown - afterLop;
    if (r.comp.isBasic || r.comp.pfApplicable) pfWages += afterLop;
    fullGross += full;
    earnedGross += afterLop;
    earnings.push({ label: r.comp.name, amount: shown });
  }

  // Deductions: PERCENT_OF_BASIC is taken on the Basic actually earned this
  // month (e.g. PF on earned basic). FIXED deductions are flat amounts.
  const deductions: CalcLine[] = [];
  if (lopAmount > 0) {
    deductions.push({ label: `Loss of Pay (${lopDays} ${lopDays === 1 ? "day" : "days"})`, amount: lopAmount });
  }
  // With state PT switched on, an old fixed "Professional Tax" component is skipped (no double PT).
  const isOldPt = (name: string) => /professional\s*tax/i.test(name);
  for (const r of rows.filter((x) => x.comp.type === "DEDUCTION" && !(input.pt && isOldPt(x.comp.name)))) {
    const amount = r.comp.calcType === "PERCENT_OF_BASIC"
      ? round((earnedBasic * r.item.value) / 10000)
      : r.item.value;
    deductions.push({ label: r.comp.name, amount });
  }

  // Provident Fund on the wages actually earned this month.
  //   Employee: 12% of PF wages (capped at the ceiling unless the school pays on full wages) -> deducted.
  //   Employer: 12% split as EPS 8.33% (always on wages up to the ceiling) + EPF the rest,
  //             plus EDLI and admin charges -> school's cost, not deducted.
  const employer: CalcLine[] = [];
  const pf = input.pf;
  if (pf && pfWages > 0) {
    const pfBase = pf.capWages ? Math.min(pfWages, pf.ceiling) : pfWages;
    const epsBase = Math.min(pfWages, pf.ceiling);
    const employeePf = round((pfBase * pf.employeeRate) / 10000);
    const eps = round((epsBase * pf.epsRate) / 10000);
    const employerTotal = round((pfBase * pf.employerRate) / 10000);
    deductions.push({ label: "PF (Employee)", amount: employeePf });
    employer.push({ label: "EPF (Employer)", amount: Math.max(0, employerTotal - eps) });
    if (pf.epsRate > 0) employer.push({ label: "EPS (Pension)", amount: eps }); // 0 rate = no EPS (e.g. age 58+)
    if (pf.edliRate) employer.push({ label: "EDLI", amount: round((epsBase * pf.edliRate) / 10000) });
    if (pf.adminRate) employer.push({ label: "PF admin charges", amount: round((pfBase * pf.adminRate) / 10000) });
  }

  // ESI on the gross earned this month (a one-off bonus is not ESI wages), for
  // people whose normal monthly gross is within the limit. Employee share is
  // waived when the average daily wage is ₹176 or less (employer still pays).
  // Contributions are rounded up to the next rupee.
  const esi = input.esi;
  if (esi && fullGross > 0 && fullGross <= esi.wageLimit && earnedGross > 0) {
    const upToRupee = (p: number) => Math.ceil(p / 100) * 100;
    const dailyAvg = fullGross / dim;
    if (dailyAvg > 17600) deductions.push({ label: "ESI (Employee)", amount: upToRupee((earnedGross * esi.employeeRate) / 10000) });
    employer.push({ label: "ESI (Employer)", amount: upToRupee((earnedGross * esi.employerRate) / 10000) });
  }

  // Professional Tax from the state slab table, on the gross earned this month.
  if (input.pt && input.pt.slabs.length) {
    const isFeb = input.month.slice(5, 7) === "02";
    const slab = [...input.pt.slabs].sort((a, b) => b.from - a.from).find((sl) => earnedGross >= sl.from);
    const amount = slab ? (isFeb && slab.febAmount ? slab.febAmount : slab.amount) : 0;
    if (amount > 0) deductions.push({ label: "Professional Tax", amount });
  }

  for (const adj of input.adjustments ?? []) {
    const line = { label: adj.label, amount: round(adj.amount) };
    if (adj.type === "EARNING") earnings.push(line);
    else deductions.push(line);
  }

  const grossPay = earnings.reduce((s, l) => s + l.amount, 0);
  const totalDeductions = deductions.reduce((s, l) => s + l.amount, 0);

  return {
    earnings,
    deductions,
    grossPay,
    totalDeductions,
    netPay: grossPay - totalDeductions,
    daysInMonth: dim,
    basisDays,
    employedDays,
    lopDays,
    paidDays: Math.round(paidDays * 100) / 100,
    employer,
    pfWages: pf ? pfWages : 0,
  };
}

// Pick the structure in force for `month`: latest effectiveFrom on/before the
// month's last day. Returns undefined if none applies yet.
export function structureForMonth<T extends { effectiveFrom: Date }>(structures: T[], month: string): T | undefined {
  const end = monthEnd(month);
  return structures
    .filter((s) => s.effectiveFrom <= end)
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
}
