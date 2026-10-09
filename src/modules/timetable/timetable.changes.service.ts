import { z } from "zod";
import type { AcademicYear } from "../../generated/prisma/client";
import { Prisma } from "../../generated/prisma/client";
import { academicDb } from "../../utils/academicContext";
import {
  TimetableConflictError, assertWritable, dowOf, formatDateOnly, httpError, loadYearContext, parseDateOnly, todayUtc,
  type YearContext,
} from "./timetable.common";
import { resKey, type Conflict } from "./timetable.engine";
import { assertDivision } from "./timetable.studio.service";
import { audit, divisionStudentUserIds, notifyUsers, teacherUserIds, type Actor } from "./timetable.notify";
import { exceptionSchema, substitutionSchema } from "./timetable.schema";

function assertDateInYear(year: AcademicYear, date: Date) {
  const start = Date.UTC(year.startDate.getUTCFullYear(), year.startDate.getUTCMonth(), year.startDate.getUTCDate());
  const end = Date.UTC(year.endDate.getUTCFullYear(), year.endDate.getUTCMonth(), year.endDate.getUTCDate());
  if (date.getTime() < start || date.getTime() > end) throw httpError(400, `Date is outside academic year ${year.label}.`);
}

/** Is `teacherId` already committed (permanent entry / exception / cover duty) at date+slot? Returns a reason or null. */
async function teacherBusyReason(
  institutionId: string, year: AcademicYear, ctx: YearContext, teacherId: string, date: Date, slotId: string,
  ignore: { entryId?: string; exceptionId?: string; divisionId?: string }
): Promise<string | null> {
  const db = academicDb();
  const dow = dowOf(date);
  if (ctx.teacherUnavailable.has(resKey(teacherId, dow, slotId))) return `${ctx.labels.teacher(teacherId)} is marked unavailable at that time.`;

  const [perm, excs, subs] = await Promise.all([
    db.timetableEntry.findMany({
      where: { institutionId, academicYearId: year.id, teacherId, dayOfWeek: dow, slotId, ...(ignore.entryId ? { id: { not: ignore.entryId } } : {}) },
      select: { id: true, divisionId: true },
    }),
    db.timetableException.findMany({ where: { institutionId, academicYearId: year.id, date, slotId } }),
    db.timetableSubstitution.findMany({ where: { institutionId, academicYearId: year.id, date, entry: { slotId } }, include: { entry: { select: { divisionId: true } } } }),
  ]);
  const excByDiv = new Map(excs.map((e) => [e.divisionId, e]));
  for (const p of perm) {
    const exc = excByDiv.get(p.divisionId);
    // The permanent session is replaced (or cancelled) on this date → teacher is free from it.
    if (exc && exc.id !== ignore.exceptionId) continue;
    const sub = subs.find((s) => s.entryId === p.id);
    if (sub) continue; // someone else covers it
    return `${ctx.labels.teacher(teacherId)} is already teaching ${ctx.labels.division(p.divisionId)} at that time.`;
  }
  for (const e of excs) {
    if (e.id === ignore.exceptionId || e.kind !== "OVERRIDE") continue;
    if (e.teacherId === teacherId) return `${ctx.labels.teacher(teacherId)} already has a special session with ${ctx.labels.division(e.divisionId)} then.`;
  }
  for (const s of subs) {
    if (s.substituteTeacherId === teacherId && s.entryId !== ignore.entryId) return `${ctx.labels.teacher(teacherId)} is already covering another class then.`;
  }
  return null;
}

const asConflict = (message: string): Conflict => ({ type: "TEACHER_CLASH", severity: "ERROR", message, entryIds: [], cells: [] });

// ── Exceptions (date-specific, permanent timetable untouched) ──────────────────
export async function listExceptions(institutionId: string, year: AcademicYear, q: { from?: string; to?: string; divisionId?: string }) {
  const ctx = await loadYearContext(institutionId, year);
  const rows = await academicDb().timetableException.findMany({
    where: {
      institutionId, academicYearId: year.id,
      ...(q.divisionId ? { divisionId: q.divisionId } : {}),
      ...(q.from || q.to ? { date: { ...(q.from ? { gte: parseDateOnly(q.from) } : {}), ...(q.to ? { lte: parseDateOnly(q.to) } : {}) } } : {}),
    },
    include: { subject: { select: { name: true } } },
    orderBy: [{ date: "asc" }, { slot: { order: "asc" } }],
    take: 1000,
  });
  return rows.map((r) => ({
    id: r.id, divisionId: r.divisionId, divisionName: ctx.labels.division(r.divisionId), date: formatDateOnly(r.date), slotId: r.slotId,
    slotName: ctx.labels.slot(r.slotId), kind: r.kind, sessionTypeId: r.sessionTypeId, sessionTypeName: r.sessionTypeId ? ctx.sessionTypes.get(r.sessionTypeId)?.name ?? null : null,
    subjectId: r.subjectId, subjectName: r.subject?.name ?? null, title: r.title, teacherId: r.teacherId,
    teacherName: r.teacherId ? ctx.labels.teacher(r.teacherId) : null, roomId: r.roomId, roomName: r.roomId ? ctx.labels.room(r.roomId) : null, reason: r.reason,
  }));
}

export async function createException(institutionId: string, year: AcademicYear, body: z.infer<typeof exceptionSchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const division = await assertDivision(institutionId, body.divisionId);
  const ctx = await loadYearContext(institutionId, year);
  const date = parseDateOnly(body.date);
  assertDateInYear(year, date);
  const dow = dowOf(date);
  if (!ctx.workingDays.includes(dow)) throw httpError(400, `${ctx.labels.day(dow)} is not a working day.`);
  const slot = ctx.slots.find((s) => s.id === body.slotId);
  if (!slot) throw httpError(400, "Time slot not found");

  if (body.kind === "OVERRIDE") {
    if (!body.sessionTypeId && !body.subjectId && !body.title) throw httpError(400, "Choose a session type, subject, or give the change a title.");
    if (body.sessionTypeId && !ctx.sessionTypes.has(body.sessionTypeId)) throw httpError(400, "Unknown session type");
    if (body.subjectId) {
      const ok = await db.subject.count({ where: { id: body.subjectId, institutionId, standardId: division.standardId } });
      if (!ok) throw httpError(400, "Subject does not belong to this class");
    }
    if (body.teacherId && !ctx.teachers.some((t) => t.id === body.teacherId)) throw httpError(400, "Teacher not found or inactive");
    if (body.roomId && !ctx.rooms.has(body.roomId)) throw httpError(400, "Room not found");
  }

  const existing = await db.timetableException.findUnique({ where: { divisionId_date_slotId: { divisionId: body.divisionId, date, slotId: body.slotId } } });
  const conflicts: Conflict[] = [];
  if (body.kind === "OVERRIDE") {
    if (body.teacherId) {
      const r = await teacherBusyReason(institutionId, year, ctx, body.teacherId, date, body.slotId, { exceptionId: existing?.id });
      if (r) conflicts.push(asConflict(r));
    }
    if (body.roomId) {
      if (ctx.roomUnavailable.has(resKey(body.roomId, dow, body.slotId))) conflicts.push({ ...asConflict(`${ctx.labels.room(body.roomId)} is unavailable at that time.`), type: "ROOM_UNAVAILABLE", roomId: body.roomId });
      const [perm, excs] = await Promise.all([
        db.timetableEntry.findMany({ where: { institutionId, academicYearId: year.id, roomId: body.roomId, dayOfWeek: dow, slotId: body.slotId }, select: { divisionId: true } }),
        db.timetableException.findMany({ where: { institutionId, academicYearId: year.id, date, slotId: body.slotId, roomId: body.roomId, ...(existing ? { id: { not: existing.id } } : {}) }, select: { divisionId: true } }),
      ]);
      const replacedDivs = new Set((await db.timetableException.findMany({ where: { institutionId, academicYearId: year.id, date, slotId: body.slotId }, select: { divisionId: true } })).map((e) => e.divisionId));
      const used = [...perm.filter((p) => p.divisionId !== body.divisionId && !replacedDivs.has(p.divisionId)), ...excs.filter((e) => e.divisionId !== body.divisionId)];
      if (used.length) conflicts.push({ ...asConflict(`${ctx.labels.room(body.roomId)} is already used by ${ctx.labels.division(used[0].divisionId)} then.`), type: "ROOM_CLASH", roomId: body.roomId });
    }
  }
  if (conflicts.length && !body.force) throw new TimetableConflictError(conflicts[0].message, conflicts);

  const data = {
    kind: body.kind, sessionTypeId: body.kind === "OVERRIDE" ? body.sessionTypeId ?? null : null, subjectId: body.kind === "OVERRIDE" ? body.subjectId ?? null : null,
    title: body.kind === "OVERRIDE" ? body.title ?? null : null, teacherId: body.kind === "OVERRIDE" ? body.teacherId ?? null : null,
    roomId: body.kind === "OVERRIDE" ? body.roomId ?? null : null, reason: body.reason ?? null,
  } satisfies Prisma.TimetableExceptionUncheckedUpdateInput;
  const saved = existing
    ? await db.timetableException.update({ where: { id: existing.id }, data })
    : await db.timetableException.create({ data: { institutionId, academicYearId: year.id, divisionId: body.divisionId, date, slotId: body.slotId, createdById: actor.userId, ...data } });

  audit(actor, "TIMETABLE_EXCEPTION_CREATED", `${body.kind === "CANCEL" ? "Cancelled" : "Changed"} ${ctx.labels.division(body.divisionId)} ${body.date} ${slot.name}`, {
    divisionId: body.divisionId, academicYearId: year.id, date: body.date, slotId: body.slotId, kind: body.kind, reason: body.reason ?? null,
  });
  await notifyException(institutionId, year, ctx, actor, saved.divisionId, date, slot.name, body.kind === "CANCEL" ? "cancelled" : "changed", [body.teacherId ?? null, await baseTeacherId(institutionId, year.id, saved.divisionId, dow, body.slotId)], body.reason ?? undefined);
  return { id: saved.id };
}

async function baseTeacherId(institutionId: string, yearId: string, divisionId: string, dow: number, slotId: string) {
  const e = await academicDb().timetableEntry.findFirst({ where: { institutionId, academicYearId: yearId, divisionId, dayOfWeek: dow, slotId }, select: { teacherId: true } });
  return e?.teacherId ?? null;
}

async function notifyException(
  institutionId: string, year: AcademicYear, ctx: YearContext, actor: Actor, divisionId: string, date: Date, slotName: string,
  what: string, teacherIds: (string | null)[], reason?: string
) {
  if (date.getTime() < todayUtc().getTime()) return;
  const [t, s] = await Promise.all([
    teacherUserIds(institutionId, teacherIds.filter((x): x is string => !!x)),
    divisionStudentUserIds(institutionId, divisionId, year.id),
  ]);
  const msg = `${formatDateOnly(date)} ${slotName}: session ${what}${reason ? ` — ${reason}` : ""}.`;
  notifyUsers({ institutionId, userIds: t, title: "Timetable change", message: `${ctx.labels.division(divisionId)} · ${msg}`, tag: "TIMETABLE_CHANGE", sentById: actor.userId });
  notifyUsers({ institutionId, userIds: s, title: "Timetable change", message: msg, tag: "TIMETABLE_CHANGE", sentById: actor.userId });
}

export async function deleteException(institutionId: string, year: AcademicYear, id: string, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const exc = await db.timetableException.findFirst({ where: { id, institutionId, academicYearId: year.id } });
  if (!exc) throw httpError(404, "Change not found");
  await db.timetableException.delete({ where: { id } });
  audit(actor, "TIMETABLE_EXCEPTION_REMOVED", `Removed date-specific change for ${formatDateOnly(exc.date)}`, { divisionId: exc.divisionId, academicYearId: year.id, date: formatDateOnly(exc.date) });
  const ctx = await loadYearContext(institutionId, year);
  await notifyException(institutionId, year, ctx, actor, exc.divisionId, exc.date, ctx.labels.slot(exc.slotId), "restored to the regular timetable", [exc.teacherId]);
}

// ── Substitutions ──────────────────────────────────────────────────────────────
export async function listSubstitutions(institutionId: string, year: AcademicYear, q: { from?: string; to?: string }) {
  const ctx = await loadYearContext(institutionId, year);
  const rows = await academicDb().timetableSubstitution.findMany({
    where: {
      institutionId, academicYearId: year.id,
      ...(q.from || q.to ? { date: { ...(q.from ? { gte: parseDateOnly(q.from) } : {}), ...(q.to ? { lte: parseDateOnly(q.to) } : {}) } } : {}),
    },
    include: { entry: { include: { subject: { select: { name: true } } } } },
    orderBy: [{ date: "asc" }],
    take: 1000,
  });
  return rows.map((r) => ({
    id: r.id, entryId: r.entryId, date: formatDateOnly(r.date), divisionId: r.entry.divisionId, divisionName: ctx.labels.division(r.entry.divisionId),
    slotId: r.entry.slotId, slotName: ctx.labels.slot(r.entry.slotId), subjectName: r.entry.subject?.name ?? r.entry.title ?? ctx.sessionTypes.get(r.entry.sessionTypeId)?.name ?? "",
    originalTeacherId: r.originalTeacherId, originalTeacherName: r.originalTeacherId ? ctx.labels.teacher(r.originalTeacherId) : null,
    substituteTeacherId: r.substituteTeacherId, substituteTeacherName: ctx.labels.teacher(r.substituteTeacherId), reason: r.reason,
  }));
}

/** Entries a teacher teaches on a given date — what an admin picks from when that teacher is absent. */
export async function teacherDayEntries(institutionId: string, year: AcademicYear, teacherId: string, dateStr: string) {
  const ctx = await loadYearContext(institutionId, year);
  const date = parseDateOnly(dateStr);
  const rows = await academicDb().timetableEntry.findMany({
    where: { institutionId, academicYearId: year.id, teacherId, dayOfWeek: dowOf(date), timetable: { status: "PUBLISHED" } },
    include: { subject: { select: { name: true } }, slot: true },
    orderBy: { slot: { order: "asc" } },
  });
  const subs = await academicDb().timetableSubstitution.findMany({ where: { institutionId, academicYearId: year.id, date, entryId: { in: rows.map((r) => r.id) } } });
  const subBy = new Map(subs.map((s) => [s.entryId, s]));
  return rows.map((r) => ({
    entryId: r.id, divisionId: r.divisionId, divisionName: ctx.labels.division(r.divisionId), slotId: r.slotId, slotName: r.slot.name,
    startMinute: r.slot.startMinute, endMinute: r.slot.endMinute, subjectName: r.subject?.name ?? r.title ?? ctx.sessionTypes.get(r.sessionTypeId)?.name ?? "",
    substituteTeacherId: subBy.get(r.id)?.substituteTeacherId ?? null, substitutionId: subBy.get(r.id)?.id ?? null,
  }));
}

export async function substituteCandidates(institutionId: string, year: AcademicYear, entryId: string, dateStr: string) {
  const ctx = await loadYearContext(institutionId, year);
  const entry = await academicDb().timetableEntry.findFirst({ where: { id: entryId, institutionId, academicYearId: year.id } });
  if (!entry) throw httpError(404, "Timetable entry not found");
  const date = parseDateOnly(dateStr);
  const out: { teacherId: string; name: string; free: boolean; reason: string | null }[] = [];
  for (const t of ctx.teachers) {
    if (t.id === entry.teacherId) continue;
    const reason = await teacherBusyReason(institutionId, year, ctx, t.id, date, entry.slotId, { entryId: entry.id });
    out.push({ teacherId: t.id, name: t.name, free: !reason, reason });
  }
  return out.sort((a, b) => Number(b.free) - Number(a.free) || a.name.localeCompare(b.name));
}

export async function createSubstitution(institutionId: string, year: AcademicYear, body: z.infer<typeof substitutionSchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const entry = await db.timetableEntry.findFirst({ where: { id: body.entryId, institutionId, academicYearId: year.id }, include: { subject: { select: { name: true } } } });
  if (!entry) throw httpError(404, "Timetable entry not found");
  const ctx = await loadYearContext(institutionId, year);
  const date = parseDateOnly(body.date);
  assertDateInYear(year, date);
  if (dowOf(date) !== entry.dayOfWeek) throw httpError(400, `That session is on ${ctx.labels.day(entry.dayOfWeek)}s, not ${ctx.labels.day(dowOf(date))}.`);
  if (!ctx.teachers.some((t) => t.id === body.substituteTeacherId)) throw httpError(400, "Substitute teacher not found or inactive");
  if (body.substituteTeacherId === entry.teacherId) throw httpError(400, "The substitute must be a different teacher.");

  const existing = await db.timetableSubstitution.findUnique({ where: { entryId_date: { entryId: entry.id, date } } });
  const reason = await teacherBusyReason(institutionId, year, ctx, body.substituteTeacherId, date, entry.slotId, { entryId: entry.id });
  if (reason && !body.force) throw new TimetableConflictError(reason, [asConflict(reason)]);

  const saved = existing
    ? await db.timetableSubstitution.update({ where: { id: existing.id }, data: { substituteTeacherId: body.substituteTeacherId, reason: body.reason ?? null, originalTeacherId: entry.teacherId } })
    : await db.timetableSubstitution.create({
        data: { institutionId, academicYearId: year.id, entryId: entry.id, date, originalTeacherId: entry.teacherId, substituteTeacherId: body.substituteTeacherId, reason: body.reason ?? null, createdById: actor.userId },
      });
  const slotName = ctx.labels.slot(entry.slotId);
  const subjectName = entry.subject?.name ?? entry.title ?? ctx.sessionTypes.get(entry.sessionTypeId)?.name ?? "Session";
  audit(actor, "TIMETABLE_SUBSTITUTE_ASSIGNED", `${ctx.labels.teacher(body.substituteTeacherId)} covers ${ctx.labels.division(entry.divisionId)} ${subjectName} on ${body.date}`, {
    divisionId: entry.divisionId, academicYearId: year.id, entryId: entry.id, date: body.date, originalTeacherId: entry.teacherId, substituteTeacherId: body.substituteTeacherId,
  });
  if (date.getTime() >= todayUtc().getTime()) {
    const [subU, origU, students] = await Promise.all([
      teacherUserIds(institutionId, [body.substituteTeacherId]),
      teacherUserIds(institutionId, entry.teacherId ? [entry.teacherId] : []),
      divisionStudentUserIds(institutionId, entry.divisionId, year.id),
    ]);
    notifyUsers({ institutionId, userIds: subU, title: "Substitution assigned", message: `${body.date} ${slotName}: cover ${ctx.labels.division(entry.divisionId)} — ${subjectName}.`, tag: "TIMETABLE_SUBSTITUTION", sentById: actor.userId });
    notifyUsers({ institutionId, userIds: origU, title: "Substitute arranged", message: `${body.date} ${slotName}: ${ctx.labels.teacher(body.substituteTeacherId)} will take ${ctx.labels.division(entry.divisionId)} — ${subjectName}.`, tag: "TIMETABLE_SUBSTITUTION", sentById: actor.userId });
    notifyUsers({ institutionId, userIds: students, title: "Teacher change", message: `${body.date} ${slotName}: ${subjectName} will be taken by ${ctx.labels.teacher(body.substituteTeacherId)}.`, tag: "TIMETABLE_SUBSTITUTION", sentById: actor.userId });
  }
  return { id: saved.id };
}

export async function deleteSubstitution(institutionId: string, year: AcademicYear, id: string, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const sub = await db.timetableSubstitution.findFirst({ where: { id, institutionId, academicYearId: year.id }, include: { entry: { select: { divisionId: true } } } });
  if (!sub) throw httpError(404, "Substitution not found");
  await db.timetableSubstitution.delete({ where: { id } });
  audit(actor, "TIMETABLE_SUBSTITUTE_REMOVED", `Removed substitution on ${formatDateOnly(sub.date)}`, { divisionId: sub.entry.divisionId, academicYearId: year.id, date: formatDateOnly(sub.date) });
}
