import { z } from "zod";
import type { AcademicYear } from "../../generated/prisma/client";
import { prisma } from "../../utils/prisma";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { decryptStudentPII } from "../../services/fieldEncryption.service";
import { logAudit } from "../../services/audit.service";
import { delCache } from "../../utils/cache";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { round2, structureTotal, studentBills, toCardDate, type FeeStructureJson, type MonthBill, type PaymentRow } from "./fees.calc";

// Fees desk: the school's fee counter. The class fee card stays the source of
// what each month costs; this collects money against it, prints receipts, keeps
// the day book and lists dues. Money in FeeReceipt is stored in paise.

export interface Actor { userId: string; role: string; institutionId: string; ip?: string }

// Narrow view of the FeeReceipt table (works before the Prisma client is regenerated).
type Row = Record<string, unknown>;
interface Delegate {
  findMany(args: Row): Promise<Row[]>;
  findFirst(args: Row): Promise<Row | null>;
  create(args: Row): Promise<Row>;
  update(args: Row): Promise<Row>;
}
const receipts = () => (academicDb() as unknown as { feeReceipt: Delegate }).feeReceipt;
const reminders = () => (academicDb() as unknown as { feeReminder: Delegate }).feeReminder;

export const MODES = ["CASH", "UPI", "CHEQUE", "CARD", "BANK"] as const;
type Mode = typeof MODES[number];

interface ReceiptLine { feeMonthId: string; month: string; heads: string[]; amount: number; discount: number; markedPaid: boolean }
interface ReceiptRow {
  id: string; number: number; receiptNo: string; studentId: string; divisionId: string | null; academicYearId: string;
  lines: ReceiptLine[]; amount: number; discount: number; mode: Mode; reference: string | null; note: string | null; day: string;
  collectedById: string | null; cancelledAt: Date | null; cancelledById: string | null; cancelReason: string | null; createdAt: Date;
}

const toPaise = (rupees: number) => Math.round(rupees * 100);
const toRupees = (paise: number) => round2(paise / 100);

/** Today in India as "YYYY-MM-DD". */
export const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

/** "2026-2027" -> "2026-27" for receipt numbers. */
function yearTag(label: string): string {
  const m = label.match(/(\d{4})\s*[-/]\s*(\d{2,4})/);
  if (m) return `${m[1]}-${m[2].slice(-2)}`;
  return label.replace(/[^\w-]+/g, "").slice(0, 12) || "FY";
}

// ── Students ─────────────────────────────────────────────────────────────────
const STUDENT_SELECT = {
  id: true, studentId: true, userId: true, rollNo: true, dob: true, admissionYear: true, avatarUrl: true,
  phone: true, guardians: true, divisionId: true, extraDetailFields: true,
  standard: { select: { id: true, name: true } },
  division: { select: { id: true, name: true } },
} as const;

type StudentRec = {
  id: string; studentId: string; userId: string; rollNo: string | null; dob: string | null; admissionYear: string | null; avatarUrl: string | null;
  phone: string | null; guardians: unknown; divisionId: string | null; extraDetailFields: unknown;
  standard: { id: string; name: string } | null; division: { id: string; name: string } | null;
};

async function institutionInfo(institutionId: string) {
  return prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true, logoUrl: true } });
}

/** Same shape as the Campus student search card (the ID card). */
async function idCards(institutionId: string, list: StudentRec[]) {
  const [users, inst, signed] = await Promise.all([
    resolveUsers(list.map((s) => s.userId), { id: true, name: true, email: true }),
    institutionInfo(institutionId),
    generateSignedAvatarUrlsBatch(list.map((s) => s.avatarUrl ?? null)),
  ]);
  return new Map(list.map((s) => {
    const u = users.get(s.userId);
    return [s.id, {
      id: s.id,
      studentId: s.studentId,
      name: u?.name ?? "",
      email: u?.email?.endsWith("@students.qubeex.local") ? null : u?.email ?? null,
      avatarUrl: s.avatarUrl ? signed[s.avatarUrl] ?? s.avatarUrl : null,
      rollNo: s.rollNo,
      dob: s.dob,
      admissionYear: s.admissionYear,
      institutionName: inst?.name ?? "",
      institutionLogoUrl: inst?.logoUrl ?? null,
      standard: s.standard,
      division: s.division,
    }];
  }));
}

/** Parent / student phone numbers for WhatsApp, from the admission details (decrypted). */
function phonesOf(s: StudentRec) {
  const pii = decryptStudentPII(s);
  const out: { label: string; name: string | null; number: string }[] = [];
  const seen = new Set<string>();
  const add = (label: string, name: string | null | undefined, number: string | null | undefined) => {
    const digits = (number ?? "").replace(/\D/g, "");
    if (digits.length < 10 || seen.has(digits.slice(-10))) return;
    seen.add(digits.slice(-10));
    out.push({ label, name: name || null, number: number! });
  };
  for (const g of Array.isArray(pii.guardians) ? pii.guardians as { name?: string; number?: string; relation?: string }[] : []) add(g?.relation || "Parent", g?.name, g?.number);
  add("Student", null, pii.phone);
  return out;
}

/** UPI / bank details printed on the class fee card, for the reminder message. */
function paymentOf(card: Row | undefined) {
  const b = card?.bankDetails as Record<string, string | undefined> | null | undefined;
  if (!b) return null;
  return { upiId: b.upiId || null, accountName: b.accountName || null, accountNumber: b.accountNumber || null, ifsc: b.ifsc || null, bankName: b.bankName || null };
}

/** The class's Late Fee Fine amount (0 when there is none). */
function lateFeeOf(card: Row | undefined) {
  const list = (Array.isArray(card?.feeStructures) ? card!.feeStructures : []) as FeeStructureJson[];
  const lf = list.find((x) => x.type === "LATE_FEE");
  return lf ? structureTotal(lf) : 0;
}

/** Latest reminder per student this year. */
async function lastReminders(institutionId: string, yearId: string, studentIds?: string[]) {
  const rows = await reminders().findMany({
    where: { institutionId, academicYearId: yearId, kind: { not: "THANKS" }, ...(studentIds ? { studentId: { in: studentIds } } : {}) },
    orderBy: { createdAt: "desc" },
    select: { studentId: true, kind: true, sentTo: true, createdAt: true },
  });
  const map = new Map<string, { kind: string; sentTo: string | null; createdAt: Date }>();
  for (const r of rows) if (!map.has(r.studentId as string)) map.set(r.studentId as string, { kind: r.kind as string, sentTo: (r.sentTo as string | null) ?? null, createdAt: r.createdAt as Date });
  return map;
}

const fieldsOf = (s: { extraDetailFields: unknown }) => (s.extraDetailFields && typeof s.extraDetailFields === "object" ? s.extraDetailFields as Record<string, string> : null);

// ── Money maths ──────────────────────────────────────────────────────────────
async function cardsFor(institutionId: string, yearId: string, divisionIds: string[]) {
  const ids = [...new Set(divisionIds)];
  if (!ids.length) return new Map<string, Row>();
  const rows = await academicDb().divisionFeeStructure.findMany({ where: { institutionId, academicYearId: yearId, divisionId: { in: ids } } });
  return new Map(rows.map((r) => [r.divisionId, r as unknown as Row]));
}

async function paymentsFor(institutionId: string, studentIds: string[]) {
  const rows = studentIds.length
    ? await academicDb().studentFeePayment.findMany({
      where: { institutionId, studentId: { in: studentIds } },
      select: { studentId: true, feeMonthId: true, status: true, paidDate: true, remark: true, extraFields: true, extraStructureIds: true },
    })
    : [];
  const map = new Map<string, typeof rows>();
  for (const r of rows) map.set(r.studentId, [...(map.get(r.studentId) ?? []), r]);
  return map;
}

/** Paise received (cash + discount) per student per fee month, from receipts that are not cancelled. */
async function receivedFor(institutionId: string, yearId: string, studentIds?: string[]) {
  const rows = await receipts().findMany({
    where: { institutionId, academicYearId: yearId, cancelledAt: null, ...(studentIds ? { studentId: { in: studentIds } } : {}) },
    select: { studentId: true, lines: true },
  });
  const map = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const per = map.get(r.studentId as string) ?? new Map<string, number>();
    for (const l of (r.lines as ReceiptLine[]) ?? []) per.set(l.feeMonthId, (per.get(l.feeMonthId) ?? 0) + l.amount + l.discount);
    map.set(r.studentId as string, per);
  }
  return map;
}

export interface BillWithMoney extends MonthBill { received: number; balance: number }

function withMoney(bills: MonthBill[], received: Map<string, number> | undefined): BillWithMoney[] {
  return bills.map((b) => {
    const got = toRupees(received?.get(b.feeMonthId) ?? 0);
    return { ...b, received: got, balance: b.status === "PAID" ? 0 : Math.max(0, round2(b.total - got)) };
  });
}

function totalsOf(bills: BillWithMoney[]) {
  const total = round2(bills.reduce((n, b) => n + b.total, 0));
  const balance = round2(bills.reduce((n, b) => n + b.balance, 0));
  const overdue = round2(bills.filter((b) => b.due).reduce((n, b) => n + b.balance, 0));
  return { total, paid: round2(total - balance), balance, overdue };
}

function billsFor(s: StudentRec, cards: Map<string, Row>, pays: Map<string, PaymentRow[]>, received: Map<string, Map<string, number>>) {
  const card = s.divisionId ? cards.get(s.divisionId) : undefined;
  const bills = studentBills(card ? { feeStructures: card.feeStructures, feeMonths: card.feeMonths, extraStudentFields: card.extraStudentFields } : null, pays.get(s.id) ?? [], fieldsOf(s));
  return withMoney(bills, received.get(s.id));
}

// ── Search ───────────────────────────────────────────────────────────────────
export async function searchStudents(institutionId: string, year: AcademicYear, q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const all = (await academicDb().student.findMany({
    where: { institutionId, status: "ACTIVE" },
    select: STUDENT_SELECT,
    orderBy: { createdAt: "asc" },
  })) as unknown as StudentRec[];
  const users = await resolveUsers(all.map((s) => s.userId), { id: true, name: true });
  const digits = needle.replace(/\D/g, "");
  const byPhone = digits.length >= 4 && digits.length === needle.replace(/[\s+-]/g, "").length;
  const matches = all.filter((s) => {
    const name = (users.get(s.userId)?.name ?? "").toLowerCase();
    if (name.includes(needle) || s.studentId.toLowerCase().includes(needle)) return true;
    if (!byPhone) return false;
    const pii = decryptStudentPII(s);
    const phones = [pii.phone, ...(Array.isArray(pii.guardians) ? pii.guardians.map((g: { number?: string }) => g?.number) : [])];
    return phones.some((p) => typeof p === "string" && p.replace(/\D/g, "").includes(digits));
  }).slice(0, 12);
  if (!matches.length) return [];

  const ids = matches.map((s) => s.id);
  const [cards, pays, received, cardsById] = await Promise.all([
    cardsFor(institutionId, year.id, matches.map((s) => s.divisionId).filter((d): d is string => !!d)),
    paymentsFor(institutionId, ids),
    receivedFor(institutionId, year.id, ids),
    idCards(institutionId, matches),
  ]);
  return matches.map((s) => ({ ...cardsById.get(s.id)!, ...totalsOf(billsFor(s, cards, pays as Map<string, PaymentRow[]>, received)) }));
}

// ── One student's account ────────────────────────────────────────────────────
async function loadStudent(institutionId: string, studentId: string) {
  const s = (await academicDb().student.findFirst({ where: { id: studentId, institutionId }, select: STUDENT_SELECT })) as unknown as StudentRec | null;
  if (!s) throw new NotFoundError("Student not found");
  return s;
}

function publicReceipt(r: Row, names?: Map<string, { name: string | null }>) {
  const x = r as unknown as ReceiptRow;
  return {
    id: x.id,
    receiptNo: x.receiptNo,
    number: x.number,
    studentId: x.studentId,
    day: x.day,
    amount: toRupees(x.amount),
    discount: toRupees(x.discount),
    mode: x.mode,
    reference: x.reference,
    note: x.note,
    lines: (x.lines ?? []).map((l) => ({ ...l, amount: toRupees(l.amount), discount: toRupees(l.discount) })),
    collectedBy: x.collectedById ? names?.get(x.collectedById)?.name ?? null : null,
    cancelled: !!x.cancelledAt,
    cancelledAt: x.cancelledAt,
    cancelReason: x.cancelReason,
    createdAt: x.createdAt,
  };
}

async function collectorNames(rows: Row[]) {
  return resolveUsers(rows.flatMap((r) => [r.collectedById as string | null, r.cancelledById as string | null]), { id: true, name: true });
}

export async function studentAccount(institutionId: string, year: AcademicYear, studentId: string) {
  const s = await loadStudent(institutionId, studentId);
  const [cards, pays, received, cardsById, list, reminded] = await Promise.all([
    cardsFor(institutionId, year.id, s.divisionId ? [s.divisionId] : []),
    paymentsFor(institutionId, [s.id]),
    receivedFor(institutionId, year.id, [s.id]),
    idCards(institutionId, [s]),
    receipts().findMany({ where: { institutionId, academicYearId: year.id, studentId: s.id }, orderBy: { number: "desc" } }),
    lastReminders(institutionId, year.id, [s.id]),
  ]);
  const bills = billsFor(s, cards, pays as Map<string, PaymentRow[]>, received);
  const card = s.divisionId ? cards.get(s.divisionId) : undefined;
  const names = await collectorNames(list);
  return {
    student: { ...cardsById.get(s.id)!, extraDetailFields: fieldsOf(s) },
    card: card ? {
      feeCardTheme: card.feeCardTheme ?? null,
      schoolLogoUrl: card.schoolLogoUrl ?? null,
      schoolName: card.schoolName ?? null,
      studentFields: card.extraStudentFields ?? [],
      extraColumns: card.extraColumns ?? [],
      feeStructures: card.feeStructures ?? [],
      feeMonths: card.feeMonths ?? [],
    } : null,
    payments: pays.get(s.id) ?? [],
    bills,
    totals: totalsOf(bills),
    receipts: list.map((r) => publicReceipt(r, names)),
    canCollect: year.isCurrent,
    phones: phonesOf(s),
    payment: paymentOf(card),
    lateFee: lateFeeOf(card),
    lastReminder: reminded.get(s.id) ?? null,
  };
}

// ── Collect ──────────────────────────────────────────────────────────────────
export const collectSchema = z.object({
  studentId: z.string().uuid(),
  lines: z.array(z.object({
    feeMonthId: z.string().min(1).max(100),
    amount: z.number().min(0).max(10_000_000),
    discount: z.number().min(0).max(10_000_000).default(0),
  }).strict()).min(1).max(24),
  mode: z.enum(MODES),
  reference: z.string().trim().max(80).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export async function collect(institutionId: string, year: AcademicYear, body: z.infer<typeof collectSchema>, actor: Actor) {
  if (!year.isCurrent) throw new BadRequestError("Fees can be collected only in the current academic year");
  const day = body.day ?? istToday();
  if (day > istToday()) throw new BadRequestError("Payment date cannot be in the future");
  if (new Set(body.lines.map((l) => l.feeMonthId)).size !== body.lines.length) throw new BadRequestError("A month is listed twice");

  const s = await loadStudent(institutionId, body.studentId);
  if (!s.divisionId) throw new BadRequestError("This student is not in a class yet");
  const [cards, pays, received] = await Promise.all([
    cardsFor(institutionId, year.id, [s.divisionId]),
    paymentsFor(institutionId, [s.id]),
    receivedFor(institutionId, year.id, [s.id]),
  ]);
  const bills = new Map(billsFor(s, cards, pays as Map<string, PaymentRow[]>, received).map((b) => [b.feeMonthId, b]));

  const lines: ReceiptLine[] = body.lines.map((l) => {
    const b = bills.get(l.feeMonthId);
    if (!b) throw new BadRequestError("A selected month is not on this student's fee card");
    if (b.balance <= 0) throw new BadRequestError(`${b.month} is already paid`);
    const take = round2(l.amount + l.discount);
    if (take <= 0) throw new BadRequestError(`Enter an amount for ${b.month}`);
    if (take > b.balance + 0.009) throw new BadRequestError(`${b.month}: only ₹${b.balance} is due`);
    return {
      feeMonthId: b.feeMonthId, month: b.month, heads: b.parts.map((p) => p.name),
      amount: toPaise(l.amount), discount: toPaise(l.discount), markedPaid: take >= b.balance - 0.009,
    };
  });
  const amount = lines.reduce((n, l) => n + l.amount, 0);
  const discount = lines.reduce((n, l) => n + l.discount, 0);

  // Next receipt number for the year; retried if two counters save at the same moment.
  let row: Row | null = null;
  for (let attempt = 0; !row; attempt++) {
    const last = await receipts().findFirst({ where: { institutionId, academicYearId: year.id }, orderBy: { number: "desc" }, select: { number: true } });
    const number = ((last?.number as number | undefined) ?? 0) + 1;
    try {
      row = await receipts().create({
        data: {
          institutionId, academicYearId: year.id, studentId: s.id, divisionId: s.divisionId,
          number, receiptNo: `${yearTag(year.label)}/${String(number).padStart(4, "0")}`,
          lines, amount, discount, mode: body.mode,
          reference: body.reference || null, note: body.note || null, day, collectedById: actor.userId,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002" || attempt >= 4) throw err;
    }
  }

  // Months now fully paid show as Paid on the class fee card too.
  for (const l of lines.filter((x) => x.markedPaid)) {
    await academicDb().studentFeePayment.upsert({
      where: { studentId_feeMonthId: { studentId: s.id, feeMonthId: l.feeMonthId } },
      create: { institutionId, studentId: s.id, feeMonthId: l.feeMonthId, status: "PAID", paidDate: toCardDate(day) },
      update: { status: "PAID", paidDate: toCardDate(day) },
    });
  }
  await delCache(`insights:fee-ai:${institutionId}`);
  logAudit("FEE_COLLECTED", {
    userId: actor.userId, actorRole: actor.role, institutionId, ip: actor.ip,
    details: `Receipt ${row.receiptNo} for ₹${toRupees(amount)} (${body.mode})`,
    metadata: { receiptId: row.id as string, studentId: s.id } as never,
  });
  return publicReceipt(row, await collectorNames([row]));
}

// ── Cancel ───────────────────────────────────────────────────────────────────
export const cancelSchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

export async function cancelReceipt(institutionId: string, id: string, reason: string, actor: Actor) {
  const r = (await receipts().findFirst({ where: { id, institutionId } })) as unknown as ReceiptRow | null;
  if (!r) throw new NotFoundError("Receipt not found");
  if (r.cancelledAt) throw new BadRequestError("This receipt is already cancelled");
  const row = await receipts().update({ where: { id }, data: { cancelledAt: new Date(), cancelledById: actor.userId, cancelReason: reason } });
  // Months this receipt marked Paid go back to Pending on the fee card.
  for (const l of r.lines.filter((x) => x.markedPaid)) {
    await academicDb().studentFeePayment.updateMany({
      where: { institutionId, studentId: r.studentId, feeMonthId: l.feeMonthId, status: "PAID" },
      data: { status: "PENDING", paidDate: null },
    });
  }
  await delCache(`insights:fee-ai:${institutionId}`);
  logAudit("FEE_RECEIPT_CANCELLED", {
    userId: actor.userId, actorRole: actor.role, institutionId, ip: actor.ip,
    details: `Receipt ${r.receiptNo} cancelled: ${reason}`,
    metadata: { receiptId: r.id, studentId: r.studentId } as never,
  });
  return publicReceipt(row, await collectorNames([row]));
}

// ── One receipt (for printing) ───────────────────────────────────────────────
/** `ownStudentId`: a student/parent may only open their own receipts. */
export async function getReceipt(institutionId: string, id: string, ownStudentId?: string) {
  const row = await receipts().findFirst({ where: { id, institutionId, ...(ownStudentId ? { studentId: ownStudentId } : {}) } });
  if (!row) throw new NotFoundError("Receipt not found");
  const r = row as unknown as ReceiptRow;
  const s = await loadStudent(institutionId, r.studentId);
  const [cards, names, inst] = await Promise.all([
    idCards(institutionId, [s]),
    collectorNames([row]),
    institutionInfo(institutionId),
  ]);
  const card = await academicDb().divisionFeeStructure.findFirst({
    where: { institutionId, academicYearId: r.academicYearId, divisionId: r.divisionId ?? "" },
    select: { schoolName: true, schoolLogoUrl: true, feeCardTheme: true },
  });
  return {
    receipt: publicReceipt(row, names),
    student: cards.get(s.id)!,
    school: { name: card?.schoolName || inst?.name || "", logoUrl: card?.schoolLogoUrl || inst?.logoUrl || null, theme: card?.feeCardTheme ?? null },
  };
}

// ── Day book ─────────────────────────────────────────────────────────────────
export async function dayBook(institutionId: string, day: string) {
  const rows = await receipts().findMany({ where: { institutionId, day }, orderBy: { createdAt: "desc" } });
  const studentIds = [...new Set(rows.map((r) => r.studentId as string))];
  const students = (await academicDb().student.findMany({ where: { institutionId, id: { in: studentIds } }, select: STUDENT_SELECT })) as unknown as StudentRec[];
  const [cards, names] = await Promise.all([idCards(institutionId, students), collectorNames(rows)]);
  const list = rows.map((r) => ({ ...publicReceipt(r, names), student: cards.get(r.studentId as string) ?? null }));
  const live = list.filter((r) => !r.cancelled);
  const byMode = Object.fromEntries(MODES.map((m) => [m, round2(live.filter((r) => r.mode === m).reduce((n, r) => n + r.amount, 0))])) as Record<Mode, number>;
  return {
    day,
    receipts: list,
    totals: {
      amount: round2(live.reduce((n, r) => n + r.amount, 0)),
      discount: round2(live.reduce((n, r) => n + r.discount, 0)),
      count: live.length,
      cancelled: list.length - live.length,
      byMode,
    },
  };
}

// ── Dues ─────────────────────────────────────────────────────────────────────
export async function dues(institutionId: string, year: AcademicYear, opts: { divisionId?: string; month?: string }) {
  const students = (await academicDb().student.findMany({
    where: { institutionId, status: "ACTIVE", divisionId: opts.divisionId ? opts.divisionId : { not: null } },
    select: STUDENT_SELECT,
  })) as unknown as StudentRec[];
  const ids = students.map((s) => s.id);
  const [cards, pays, received, divisions, reminded, inst] = await Promise.all([
    cardsFor(institutionId, year.id, students.map((s) => s.divisionId!)),
    paymentsFor(institutionId, ids),
    receivedFor(institutionId, year.id),
    academicDb().division.findMany({
      where: { institutionId },
      select: { id: true, name: true, standard: { select: { id: true, name: true, order: true } } },
    }),
    lastReminders(institutionId, year.id),
    institutionInfo(institutionId),
  ]);

  const months = new Set<string>();
  const owing = students.flatMap((s) => {
    const all = billsFor(s, cards, pays as Map<string, PaymentRow[]>, received);
    all.forEach((b) => months.add(b.month));
    const bills = opts.month ? all.filter((b) => b.month === opts.month) : all;
    const open = bills.filter((b) => b.balance > 0);
    if (!open.length) return [];
    const overdueBills = open.filter((b) => b.due);
    const oldest = overdueBills[0] ?? null;
    return [{
      s,
      balance: round2(open.reduce((n, b) => n + b.balance, 0)),
      overdue: round2(overdueBills.reduce((n, b) => n + b.balance, 0)),
      overdueMonths: overdueBills.map((b) => b.month),
      oldestDue: oldest ? { month: oldest.month, dueDate: oldest.dueDate } : null,
      openMonths: open.map((b) => ({ month: b.month, dueDate: b.dueDate, balance: b.balance, due: b.due })),
    }];
  });
  owing.sort((a, b) => b.overdue - a.overdue || b.balance - a.balance);

  const cardsById = await idCards(institutionId, owing.map((o) => o.s));
  const perClass = new Map<string, { overdue: number; balance: number; students: number }>();
  for (const o of owing) {
    const c = perClass.get(o.s.divisionId!) ?? { overdue: 0, balance: 0, students: 0 };
    c.overdue = round2(c.overdue + o.overdue); c.balance = round2(c.balance + o.balance); c.students++;
    perClass.set(o.s.divisionId!, c);
  }
  const classes = divisions
    .filter((d) => cards.has(d.id) || perClass.has(d.id))
    .sort((a, b) => (a.standard?.order ?? 0) - (b.standard?.order ?? 0) || a.name.localeCompare(b.name))
    .map((d) => ({ divisionId: d.id, standard: d.standard?.name ?? "", division: d.name, ...(perClass.get(d.id) ?? { overdue: 0, balance: 0, students: 0 }) }));

  // Fee-card month order (April first for most schools), from any card.
  const order = [...cards.values()].flatMap((c) => (Array.isArray(c.feeMonths) ? c.feeMonths as { month: string }[] : []).map((m) => m.month));
  const monthList = [...new Set(order)].filter((m) => months.has(m));

  return {
    students: owing.map((o) => {
      const card = cards.get(o.s.divisionId!);
      return {
        ...cardsById.get(o.s.id)!, balance: o.balance, overdue: o.overdue, overdueMonths: o.overdueMonths, oldestDue: o.oldestDue,
        openMonths: o.openMonths, phones: phonesOf(o.s), upiId: paymentOf(card)?.upiId ?? null, lateFee: lateFeeOf(card),
        schoolName: (card?.schoolName as string | null) || inst?.name || "", lastReminder: reminded.get(o.s.id) ?? null,
      };
    }),
    classes,
    months: monthList,
    totals: {
      students: owing.length,
      balance: round2(owing.reduce((n, o) => n + o.balance, 0)),
      overdue: round2(owing.reduce((n, o) => n + o.overdue, 0)),
    },
  };
}

// ── Reminders ────────────────────────────────────────────────────────────────
export const reminderSchema = z.object({
  studentId: z.string().uuid(),
  kind: z.enum(["GENTLE", "OVERDUE", "FINAL", "THANKS"]),
  lang: z.enum(["en", "hi"]).default("en"),
  sentTo: z.string().trim().max(40).nullable().optional(),
  amount: z.number().min(0).max(10_000_000).default(0),
}).strict();

/** Notes that a WhatsApp reminder was opened for a parent (WhatsApp cannot tell us it was sent). */
export async function logReminder(institutionId: string, year: AcademicYear, body: z.infer<typeof reminderSchema>, actor: Actor) {
  await loadStudent(institutionId, body.studentId);
  const row = await reminders().create({
    data: {
      institutionId, academicYearId: year.id, studentId: body.studentId, kind: body.kind, lang: body.lang,
      sentTo: body.sentTo || null, amount: toPaise(body.amount), sentById: actor.userId,
    },
  });
  return { id: row.id, kind: row.kind, sentTo: row.sentTo ?? null, createdAt: row.createdAt };
}

// ── Student / parent view ────────────────────────────────────────────────────
/**
 * What the student's own fee page shows next to the fee card: paid and still
 * due per month (part payments too) and their receipts (cancelled ones left out).
 * `divisionId` is the class whose fee card applies for that year.
 */
export async function studentMoney(institutionId: string, year: AcademicYear, studentId: string, divisionId: string) {
  const s = { ...(await loadStudent(institutionId, studentId)), divisionId };
  const [cards, pays, received, list] = await Promise.all([
    cardsFor(institutionId, year.id, [divisionId]),
    paymentsFor(institutionId, [s.id]),
    receivedFor(institutionId, year.id, [s.id]),
    receipts().findMany({ where: { institutionId, academicYearId: year.id, studentId: s.id, cancelledAt: null }, orderBy: { number: "desc" } }),
  ]);
  const bills = billsFor(s, cards, pays as Map<string, PaymentRow[]>, received);
  const names = await collectorNames(list);
  return {
    bills: bills.map((b) => ({ feeMonthId: b.feeMonthId, month: b.month, total: b.total, received: b.received, balance: b.balance, due: b.due })),
    totals: totalsOf(bills),
    receipts: list.map((r) => publicReceipt(r, names)),
  };
}

// ── Copy a class's fee setup to other classes ────────────────────────────────
/**
 * Per class this year: is a fee card set up, and has anyone paid against it yet.
 * A class with payments is never overwritten (its months are what those payments point to).
 */
export async function setupStatus(institutionId: string, year: AcademicYear) {
  const db = academicDb();
  const cards = await db.divisionFeeStructure.findMany({ where: { institutionId, academicYearId: year.id }, select: { divisionId: true, feeMonths: true } });
  const divisionIds = cards.map((c) => c.divisionId);
  const [students, paidReceipts] = await Promise.all([
    divisionIds.length ? db.student.findMany({ where: { institutionId, divisionId: { in: divisionIds } }, select: { id: true, divisionId: true } }) : Promise.resolve([] as { id: string; divisionId: string | null }[]),
    receipts().findMany({ where: { institutionId, academicYearId: year.id, cancelledAt: null }, select: { divisionId: true } }),
  ]);
  const withReceipts = new Set(paidReceipts.map((r) => r.divisionId as string | null).filter((d): d is string => !!d));
  const monthIds = cards.flatMap((c) => (Array.isArray(c.feeMonths) ? (c.feeMonths as { id: string }[]).map((m) => m.id) : []));
  const paid = students.length && monthIds.length
    ? await db.studentFeePayment.findMany({ where: { institutionId, status: "PAID", studentId: { in: students.map((s) => s.id) }, feeMonthId: { in: monthIds } }, select: { studentId: true, feeMonthId: true } })
    : [];
  const divisionOf = new Map<string, string | null>(students.map((s) => [s.id, s.divisionId]));
  const monthsOf = new Map(cards.map((c) => [c.divisionId, new Set(Array.isArray(c.feeMonths) ? (c.feeMonths as { id: string }[]).map((m) => m.id) : [])]));
  const withPaid = new Set(paid.filter((p) => monthsOf.get(divisionOf.get(p.studentId) ?? "")?.has(p.feeMonthId)).map((p) => divisionOf.get(p.studentId)!));
  return cards.map((c) => ({
    divisionId: c.divisionId,
    months: Array.isArray(c.feeMonths) ? c.feeMonths.length : 0,
    hasPayments: withReceipts.has(c.divisionId) || withPaid.has(c.divisionId),
  }));
}

export const copySetupSchema = z.object({
  fromDivisionId: z.string().uuid(),
  toDivisionIds: z.array(z.string().uuid()).min(1).max(200),
}).strict();

export async function copySetup(institutionId: string, year: AcademicYear, body: z.infer<typeof copySetupSchema>, actor: Actor) {
  if (!year.isCurrent) throw new BadRequestError("Fee setup can be copied only in the current academic year");
  const db = academicDb();
  const src = await db.divisionFeeStructure.findFirst({ where: { institutionId, academicYearId: year.id, divisionId: body.fromDivisionId } });
  if (!src) throw new BadRequestError("Save this class's fee setup first, then copy it");
  const [status, divisions] = await Promise.all([
    setupStatus(institutionId, year),
    db.division.findMany({ where: { institutionId, id: { in: body.toDivisionIds } }, select: { id: true } }),
  ]);
  const locked = new Set(status.filter((x) => x.hasPayments).map((x) => x.divisionId));
  const valid = new Set(divisions.map((d) => d.id));
  const data = {
    feeStructures: src.feeStructures as object,
    feeMonths: src.feeMonths as object,
    extraColumns: src.extraColumns as object,
    extraStudentFields: src.extraStudentFields as object,
    bankDetails: (src.bankDetails as object | null) ?? undefined,
    qrImageUrl: src.qrImageUrl,
    generalRemark: src.generalRemark,
    feeCardTheme: src.feeCardTheme,
    schoolLogoUrl: src.schoolLogoUrl,
    schoolName: src.schoolName,
    rulesAndRegs: (src.rulesAndRegs as object | null) ?? undefined,
  };
  const copied: string[] = [];
  const skipped: { divisionId: string; reason: string }[] = [];
  for (const id of [...new Set(body.toDivisionIds)]) {
    if (id === body.fromDivisionId) continue;
    if (!valid.has(id)) { skipped.push({ divisionId: id, reason: "Class not found" }); continue; }
    if (locked.has(id)) { skipped.push({ divisionId: id, reason: "Fees already paid in this class" }); continue; }
    await db.divisionFeeStructure.upsert({
      where: { divisionId_academicYearId: { divisionId: id, academicYearId: year.id } },
      create: { institutionId, academicYearId: year.id, divisionId: id, ...data },
      update: data,
    });
    copied.push(id);
  }
  logAudit("FEE_SETUP_COPIED", {
    userId: actor.userId, actorRole: actor.role, institutionId, ip: actor.ip,
    details: `Fee setup copied to ${copied.length} class${copied.length === 1 ? "" : "es"}`,
    metadata: { fromDivisionId: body.fromDivisionId, toDivisionIds: copied } as never,
  });
  return { copied, skipped };
}
