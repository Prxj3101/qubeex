import { academicDb } from "../utils/academicContext";
import { getCurrentAcademicYear } from "../utils/academicYear";
import { BadRequestError, NotFoundError } from "../utils/errors";

// One place that decides who rides which bus AND what that does to their fee.
// Used by the fee card (Campus → Fees) and the Transport page, so both always
// show the same thing.
//
// Two stores, kept in sync here:
//  • StudentTransport row: bus, stop, shift (what the map / parent app use).
//  • Student.extraDetailFields, under the fee card's Bus field id (default
//    "f-bus"), what the fee card and every fee view read:
//      `${id}-enabled`    "true" | "false"   on the bus right now
//      `${id}-number`     bus name (display only)
//      `${id}-fee`        monthly bus fee (rupees) for months not locked
//      `${id}-months`     JSON array of fee-month ids that carry bus fee
//      `${id}-monthFees`  JSON { monthId: amount }: months whose bus fee is
//                         locked (already due or paid when the bus was turned
//                         off or the fee changed), so old bills never change.
//
// A month carries bus fee when (enabled && month in months) or it is locked;
// the amount is its locked amount, else `${id}-fee`. Same rule in every view
// (see busMonthAmount and the web/app copies).

export type Shift = "MORNING" | "AFTERNOON";
type Fields = Record<string, string>;
type FeeMonth = { id: string; month: string; dueDate: string };

export const DEFAULT_BUS_FIELD_ID = "f-bus";
/** Needs a bus, not given yet: set at admission (pickup area or "Yes") or from the fee card ("FEE_CARD"); cleared once a bus is given. */
export const BUS_REQUEST_KEY = "bus-request";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Fee-card dates are free text like "10 Apr 26" (same parsing as the web).
function parseFlexDate(input: string | null | undefined): Date | null {
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

const jsonArray = (raw: string | undefined): string[] => {
  try { const v = JSON.parse(raw ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};
const jsonAmounts = (raw: string | undefined): Record<string, number> => {
  try {
    const v = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number" && Number.isFinite(n))) as Record<string, number>;
  } catch { return {}; }
};

/** Bus fee for one month (null = no bus fee that month). The shared rule. */
export function busMonthAmount(fields: Fields, fieldId: string, monthId: string): number | null {
  const locked = jsonAmounts(fields[`${fieldId}-monthFees`]);
  if (monthId in locked) return locked[monthId];
  if (fields[`${fieldId}-enabled`] !== "true") return null;
  if (!jsonArray(fields[`${fieldId}-months`]).includes(monthId)) return null;
  return Number(fields[`${fieldId}-fee`]) || 0;
}

function busFieldIdOf(studentFields: unknown): string {
  if (Array.isArray(studentFields)) {
    const f = studentFields.find((x) => x && typeof x === "object" && (x as { kind?: string }).kind === "default" && (x as { defaultKey?: string }).defaultKey === "bus") as { id?: string } | undefined;
    if (f?.id) return f.id;
  }
  return DEFAULT_BUS_FIELD_ID;
}

/** Everything needed to change one student's bus fee: their fields, the fee card's months and which are paid. */
async function loadFeeContext(studentId: string, institutionId: string) {
  const db = academicDb();
  const student = await db.student.findFirst({ where: { id: studentId, institutionId }, select: { id: true, divisionId: true, extraDetailFields: true } });
  if (!student) throw new NotFoundError("Student not found");
  let fieldId = DEFAULT_BUS_FIELD_ID;
  let feeMonths: FeeMonth[] = [];
  if (student.divisionId) {
    const year = await getCurrentAcademicYear(institutionId);
    const structure = await db.divisionFeeStructure.findFirst({
      where: { divisionId: student.divisionId, institutionId, academicYearId: year.id },
      select: { extraStudentFields: true, feeMonths: true },
    });
    if (structure) {
      fieldId = busFieldIdOf(structure.extraStudentFields);
      feeMonths = Array.isArray(structure.feeMonths) ? (structure.feeMonths as unknown as FeeMonth[]).filter((m) => m && typeof m.id === "string") : [];
    }
  }
  const paid = feeMonths.length
    ? await db.studentFeePayment.findMany({ where: { studentId, feeMonthId: { in: feeMonths.map((m) => m.id) }, status: "PAID" }, select: { feeMonthId: true } })
    : [];
  return {
    fields: { ...((student.extraDetailFields as Fields | null) ?? {}) },
    fieldId,
    feeMonths,
    paidIds: new Set(paid.map((p) => p.feeMonthId)),
  };
}

const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const isDueOrPast = (m: FeeMonth) => { const d = parseFlexDate(m.dueDate); return !!d && d.getTime() <= today().getTime(); };

/** Freeze the bus fee of months already due or paid, at what they charge now. */
function lockPastMonths(fields: Fields, fieldId: string, feeMonths: FeeMonth[], paidIds: Set<string>): void {
  const locked = jsonAmounts(fields[`${fieldId}-monthFees`]);
  let changed = false;
  for (const m of feeMonths) {
    if (m.id in locked) continue;
    if (!(paidIds.has(m.id) || isDueOrPast(m))) continue;
    const amount = busMonthAmount(fields, fieldId, m.id);
    if (amount == null) continue;
    locked[m.id] = amount;
    changed = true;
  }
  if (changed) fields[`${fieldId}-monthFees`] = JSON.stringify(locked);
}

type FeePatch = { enabled?: boolean; busName?: string; fee?: number | null; months?: string[] };

/** Apply a change to a student's bus fee fields, locking old months first when needed. Returns the new fields. */
async function writeBusFee(studentId: string, institutionId: string, patch: FeePatch): Promise<Fields> {
  const { fields, fieldId, feeMonths, paidIds } = await loadFeeContext(studentId, institutionId);
  const k = (s: string) => `${fieldId}-${s}`;
  const wasOn = fields[k("enabled")] === "true";
  const feeChanges = patch.fee !== undefined && String(patch.fee ?? "") !== (fields[k("fee")] ?? "");
  if ((patch.enabled === false && wasOn) || feeChanges) lockPastMonths(fields, fieldId, feeMonths, paidIds);

  if (patch.enabled !== undefined) fields[k("enabled")] = patch.enabled ? "true" : "false";
  if (patch.enabled === true) delete fields[BUS_REQUEST_KEY]; // request met
  if (patch.busName !== undefined) fields[k("number")] = patch.busName;
  if (patch.fee !== undefined) fields[k("fee")] = patch.fee == null ? "" : String(patch.fee);
  if (patch.months !== undefined) {
    // months picked by hand: a month taken out loses its bus fee, even if locked
    const keep = new Set(patch.months);
    fields[k("months")] = JSON.stringify(patch.months);
    const locked = jsonAmounts(fields[k("monthFees")]);
    fields[k("monthFees")] = JSON.stringify(Object.fromEntries(Object.entries(locked).filter(([id]) => keep.has(id))));
  } else if (patch.enabled === true && !wasOn) {
    // just put on a bus: charge the months still to come (not already due)
    // Months locked earlier (bus was on then) stay in the list too, so the
    // month picker shows them ticked and saving it doesn't drop them.
    const locked = jsonAmounts(fields[k("monthFees")]);
    const months = feeMonths.filter((m) => m.id in locked || (!isDueOrPast(m) && !paidIds.has(m.id))).map((m) => m.id);
    for (const id of Object.keys(locked)) if (!months.includes(id)) months.push(id); // locked month no longer on the card
    fields[k("months")] = JSON.stringify(months);
  }

  await academicDb().student.update({ where: { id: studentId }, data: { extraDetailFields: fields } });
  return fields;
}

async function checkBusAndStop(institutionId: string, busId: string, stopId: string | null) {
  const db = academicDb();
  const bus = await db.transportBus.findFirst({ where: { id: busId, institutionId }, select: { id: true, name: true, routeId: true, morningShift: true, afternoonShift: true } });
  if (!bus) throw new NotFoundError("Bus not found");
  let stopFee: number | null = null;
  if (stopId) {
    const stop = bus.routeId ? await db.transportStop.findFirst({ where: { id: stopId, routeId: bus.routeId }, select: { monthlyFee: true } }) : null;
    if (!stop) throw new BadRequestError("This stop is not on the bus's route");
    stopFee = stop.monthlyFee;
  }
  return { bus, stopFee };
}

/**
 * Put a student on a bus (or change bus / stop / shift). Keeps the fee card in
 * step: bus fee turned on with the bus's name; the fee follows the stop's
 * monthly fee when the stop changes (or when no fee was set yet), unless an
 * explicit `fee` is given.
 */
export async function assignStudentBus(institutionId: string, studentId: string, input: {
  busId: string; stopId: string | null; shift?: Shift; fee?: number | null; months?: string[];
}): Promise<Fields> {
  const db = academicDb();
  if (!(await db.student.count({ where: { id: studentId, institutionId } }))) throw new NotFoundError("Student not found");
  const { bus, stopFee } = await checkBusAndStop(institutionId, input.busId, input.stopId);
  const current = await db.studentTransport.findUnique({ where: { studentId }, select: { stopId: true, shift: true } });
  // bus runs one shift: that's the shift; both: the one asked for, else what they had, else morning
  const shift: Shift = !bus.afternoonShift ? "MORNING" : !bus.morningShift ? "AFTERNOON" : input.shift ?? (current?.shift as Shift | undefined) ?? "MORNING";
  await db.studentTransport.upsert({
    where: { studentId },
    create: { institutionId, studentId, busId: bus.id, stopId: input.stopId, shift },
    update: { busId: bus.id, stopId: input.stopId, shift },
  });

  let fee: number | null | undefined = input.fee;
  if (fee === undefined && stopFee != null) {
    const { fields, fieldId } = await loadFeeContext(studentId, institutionId);
    const noFeeYet = !(fields[`${fieldId}-fee`] ?? "").trim();
    if (noFeeYet || current?.stopId !== input.stopId) fee = stopFee;
  }
  return writeBusFee(studentId, institutionId, { enabled: true, busName: bus.name, fee, months: input.months });
}

/**
 * The fee card's months for a student's bus fee picker: each month, whether it
 * is already due / paid, and which are ticked by default (what they have now,
 * or for someone just getting a bus: months locked earlier + months to come).
 */
export async function busFeeMonths(institutionId: string, studentId: string) {
  const { fields, fieldId, feeMonths, paidIds } = await loadFeeContext(studentId, institutionId);
  const locked = jsonAmounts(fields[`${fieldId}-monthFees`]);
  const on = fields[`${fieldId}-enabled`] === "true";
  const selected = on
    ? feeMonths.filter((m) => busMonthAmount(fields, fieldId, m.id) != null).map((m) => m.id)
    : feeMonths.filter((m) => m.id in locked || (!isDueOrPast(m) && !paidIds.has(m.id))).map((m) => m.id);
  return {
    months: feeMonths.map((m) => ({ id: m.id, month: m.month, dueDate: m.dueDate, due: isDueOrPast(m), paid: paidIds.has(m.id) })),
    selected,
  };
}

/** Take a student off their bus. Bus fee stops from the next due month; months already due or paid keep theirs. */
export async function removeStudentBus(institutionId: string, studentId: string): Promise<Fields> {
  await academicDb().studentTransport.deleteMany({ where: { studentId, institutionId } });
  return writeBusFee(studentId, institutionId, { enabled: false, busName: "" });
}

/** Change only the bus fee amount and/or the months it applies to (fee card). */
export async function updateStudentBusFee(institutionId: string, studentId: string, patch: { fee?: number | null; months?: string[] }): Promise<Fields> {
  return writeBusFee(studentId, institutionId, patch);
}

/** When a bus is renamed, the name shown on fee cards follows. */
export async function renameBusOnFeeCards(institutionId: string, busId: string, name: string): Promise<void> {
  const db = academicDb();
  const riders = await db.studentTransport.findMany({ where: { busId, institutionId }, select: { studentId: true } });
  for (const r of riders) {
    const { fields, fieldId } = await loadFeeContext(r.studentId, institutionId);
    if (fields[`${fieldId}-number`] === name) continue;
    fields[`${fieldId}-number`] = name;
    await db.student.update({ where: { id: r.studentId }, data: { extraDetailFields: fields } });
  }
}
