import { busMonthAmount, DEFAULT_BUS_FIELD_ID } from "../../services/studentBus.service";

// Fee card maths for one student, the same rules the class fee card uses on the
// web (Fees tab and the student's fee page): the month's shared structures, plus
// structures added just for this student, plus the Late Fee Fine once the month
// is overdue and unpaid, plus the student's own Bus Fee for the months picked.

export interface FeeSubItem { id?: string; label?: string; amount: number }
export interface FeeItem { id?: string; label?: string; amount: number; subItems?: FeeSubItem[] }
export interface FeeStructureJson { id: string; name: string; type: string; color: string; items: FeeItem[] }
export interface FeeMonthJson { id: string; month: string; dueDate: string; assignedStructureIds: string[]; remark?: string }
export interface PaymentRow { feeMonthId: string; status: string; paidDate: string | null; extraStructureIds: unknown }

export interface MonthPart { id: string; name: string; type: string; color: string; amount: number; auto?: "late" | "bus"; extra?: boolean }
export interface MonthBill {
  feeMonthId: string;
  month: string;
  dueDate: string;
  parts: MonthPart[];
  total: number;
  status: "PAID" | "PENDING";
  paidDate: string | null;
  /** Due date has passed. */
  due: boolean;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const BUS_COLOR = "#0891B2";

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function structureTotal(s: FeeStructureJson): number {
  return (s.items ?? []).reduce((n, item) => {
    const sub = (item.subItems ?? []).reduce((m, si) => m + (Number(si.amount) || 0), 0);
    return n + (sub > 0 ? sub : Number(item.amount) || 0);
  }, 0);
}

/** Fee-card dates are free text like "10 Apr 26" (same parsing as the web). */
export function parseFlexDate(input: string | null | undefined): Date | null {
  const str = input?.trim();
  if (!str) return null;
  const monthIdx = MONTHS.findIndex((m) => new RegExp(`\\b${m.slice(0, 3)}`, "i").test(str));
  if (monthIdx === -1) return null;
  const nums = str.match(/\d+/g);
  if (!nums?.length) return null;
  const day = parseInt(nums[0], 10);
  if (Number.isNaN(day) || day < 1 || day > 31) return null;
  let year = new Date().getFullYear();
  if (nums.length > 1) {
    const y = parseInt(nums[1], 10);
    if (!Number.isNaN(y)) year = y < 100 ? 2000 + y : y;
  }
  const d = new Date(year, monthIdx, day);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dayStart = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };

/** True once today is past the due date. */
export function isPastDue(dueDate: string | null | undefined, today = new Date()): boolean {
  const due = parseFlexDate(dueDate);
  return !!due && dayStart(today) > dayStart(due);
}

/** Late Fee Fine rule from the web fee card: overdue and not paid on time. */
export function isLateFeeApplicable(dueDate: string | null | undefined, paidDate: string | null | undefined, today = new Date()): boolean {
  if (!isPastDue(dueDate, today)) return false;
  if (!paidDate?.trim()) return true;
  const paid = parseFlexDate(paidDate);
  const due = parseFlexDate(dueDate)!;
  return !paid || dayStart(paid) > dayStart(due);
}

/** "2026-11-11" -> "11 Nov 26", the paid-date format the fee card uses. */
export function toCardDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${String(y).slice(-2)}`;
}

export function busFieldIdOf(studentFields: unknown): string {
  if (Array.isArray(studentFields)) {
    const f = studentFields.find((x) => x && typeof x === "object" && (x as { kind?: string }).kind === "default" && (x as { defaultKey?: string }).defaultKey === "bus") as { id?: string } | undefined;
    if (f?.id) return f.id;
  }
  return DEFAULT_BUS_FIELD_ID;
}

/** Every fee month on the student's card with what it costs this student. */
export function studentBills(
  card: { feeStructures: unknown; feeMonths: unknown; extraStudentFields: unknown } | null,
  payments: PaymentRow[],
  fields: Record<string, string> | null,
  today = new Date(),
): MonthBill[] {
  if (!card) return [];
  const structures = (Array.isArray(card.feeStructures) ? card.feeStructures : []) as FeeStructureJson[];
  const months = (Array.isArray(card.feeMonths) ? card.feeMonths : []) as FeeMonthJson[];
  const byId = new Map(structures.map((s) => [s.id, s]));
  const lateFee = structures.find((s) => s.type === "LATE_FEE");
  const busStructure = structures.find((s) => s.type === "BUS");
  const busFieldId = busFieldIdOf(card.extraStudentFields);
  const payOf = new Map(payments.map((p) => [p.feeMonthId, p]));

  return months.map((m) => {
    const pay = payOf.get(m.id);
    const assigned = new Set(m.assignedStructureIds ?? []);
    const parts: MonthPart[] = [];
    for (const id of assigned) {
      const s = byId.get(id);
      if (s) parts.push({ id: s.id, name: s.name, type: s.type, color: s.color, amount: structureTotal(s) });
    }
    const extraIds = (Array.isArray(pay?.extraStructureIds) ? pay!.extraStructureIds as string[] : []).filter((id) => !assigned.has(id));
    for (const id of extraIds) {
      const s = byId.get(id);
      if (s) parts.push({ id: s.id, name: s.name, type: s.type, color: s.color, amount: structureTotal(s), extra: true });
    }
    if (lateFee && !assigned.has(lateFee.id) && !extraIds.includes(lateFee.id) && isLateFeeApplicable(m.dueDate, pay?.paidDate, today)) {
      parts.push({ id: lateFee.id, name: lateFee.name, type: lateFee.type, color: lateFee.color, amount: structureTotal(lateFee), auto: "late" });
    }
    const bus = busMonthAmount(fields ?? {}, busFieldId, m.id);
    if (bus != null && !(busStructure && assigned.has(busStructure.id))) {
      parts.push({ id: busStructure?.id ?? "fs-bus-default", name: busStructure?.name ?? "Bus Fee", type: "BUS", color: busStructure?.color ?? BUS_COLOR, amount: bus, auto: "bus" });
    }
    return {
      feeMonthId: m.id,
      month: m.month,
      dueDate: m.dueDate,
      parts,
      total: round2(parts.reduce((n, p) => n + p.amount, 0)),
      status: pay?.status === "PAID" ? "PAID" : "PENDING",
      paidDate: pay?.paidDate ?? null,
      due: isPastDue(m.dueDate, today),
    };
  });
}
