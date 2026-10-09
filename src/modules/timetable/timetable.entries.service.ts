import { randomUUID } from "crypto";
import { z } from "zod";
import type { AcademicYear } from "../../generated/prisma/client";
import { academicDb } from "../../utils/academicContext";
import {
  TimetableConflictError, assertWritable, httpError, loadYearContext, loadYearEntries, type YearContext,
} from "./timetable.common";
import { conflictsForEntries, type Conflict, type EngineEntry, type EngineSlot } from "./timetable.engine";
import {
  assertDivision, assignmentTeachers, decorateEntries, getOrCreateTimetable, yearConflicts,
} from "./timetable.studio.service";
import { audit, divisionStudentUserIds, notifyUsers, teacherUserIds, type Actor } from "./timetable.notify";
import {
  applyToAllSchema, bulkDeleteSchema, copyDaySchema, entryCreateSchema, entryMoveSchema, entryPatchSchema, entrySwapSchema,
  restoreSchema,
} from "./timetable.schema";

const sig = (c: Conflict) => `${c.type}:${[...c.entryIds].sort().join(",")}:${c.message}`;

/**
 * Compare conflicts before/after a proposed change; reject (409) if the change introduces new hard
 * conflicts on touched entries, unless the admin explicitly forced it. Returns the new warnings.
 */
function validateChange(ctx: YearContext, before: EngineEntry[], after: EngineEntry[], touched: string[], force?: boolean): Conflict[] {
  const prior = new Set(yearConflicts(ctx, before).map(sig));
  const next = yearConflicts(ctx, after);
  const fresh = conflictsForEntries(next, touched).filter((c) => !prior.has(sig(c)));
  if (fresh.length && !force) {
    throw new TimetableConflictError(
      fresh.length === 1 ? fresh[0].message : `${fresh.length} conflicts would be created by this change.`,
      fresh
    );
  }
  return fresh;
}

/** `n` consecutive teaching slots starting at `startSlotId` (no break between), or null. */
export function consecutiveSlots(slots: EngineSlot[], startSlotId: string, n: number): EngineSlot[] | null {
  const ordered = [...slots].sort((a, b) => a.order - b.order);
  const i = ordered.findIndex((s) => s.id === startSlotId);
  if (i < 0) return null;
  if (n === 1) return [ordered[i]];
  const out = [ordered[i]];
  if (ordered[i].kind !== "PERIOD") return null;
  for (let k = 1; k < n; k++) {
    const next = ordered[i + k];
    if (!next || next.kind !== "PERIOD") return null;
    out.push(next);
  }
  return out;
}

async function loadTimetableRow(institutionId: string, year: AcademicYear, divisionId: string) {
  await assertDivision(institutionId, divisionId);
  return getOrCreateTimetable(institutionId, year, divisionId);
}

async function loadEntryOrThrow(institutionId: string, year: AcademicYear, id: string) {
  const entry = await academicDb().timetableEntry.findFirst({ where: { id, institutionId, academicYearId: year.id } });
  if (!entry) throw httpError(404, "Timetable entry not found");
  return entry;
}

async function groupOf(entry: { id: string; groupId: string | null; timetableId: string }) {
  if (!entry.groupId) return [entry.id];
  const rows = await academicDb().timetableEntry.findMany({
    where: { timetableId: entry.timetableId, groupId: entry.groupId },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

async function validateRefs(
  institutionId: string, divisionId: string, ctx: YearContext,
  refs: { sessionTypeId?: string; subjectId?: string | null; teacherId?: string | null; roomId?: string | null; configId?: string | null },
  yearId: string
) {
  const db = academicDb();
  if (refs.sessionTypeId && !ctx.sessionTypes.has(refs.sessionTypeId)) throw httpError(400, "Unknown session type");
  if (refs.sessionTypeId && ctx.sessionTypes.get(refs.sessionTypeId)?.isActive === false) throw httpError(400, "This session type is deactivated");
  if (refs.subjectId) {
    const division = await assertDivision(institutionId, divisionId);
    const ok = await db.subject.count({ where: { id: refs.subjectId, institutionId, standardId: division.standardId } });
    if (!ok) throw httpError(400, "Subject does not belong to this class");
  }
  if (refs.teacherId && !ctx.teachers.some((t) => t.id === refs.teacherId)) throw httpError(400, "Teacher not found or inactive");
  if (refs.roomId && !ctx.rooms.has(refs.roomId)) throw httpError(400, "Room not found");
  if (refs.roomId && ctx.rooms.get(refs.roomId)?.isActive === false) throw httpError(400, "Room is deactivated");
  if (refs.configId) {
    const ok = await db.timetableSubjectConfig.count({ where: { id: refs.configId, institutionId, academicYearId: yearId, divisionId } });
    if (!ok) throw httpError(400, "Requirement not found for this class");
  }
}

function describe(ctx: YearContext, e: { dayOfWeek: number; slotId: string }) {
  return `${ctx.labels.day(e.dayOfWeek)} ${ctx.labels.slot(e.slotId)}`;
}

/** Tell the people affected by a change to an already-published timetable. */
async function notifyPublishedChange(params: {
  institutionId: string; year: AcademicYear; divisionId: string; ctx: YearContext; actor: Actor;
  teacherIds: (string | null)[]; summary: string;
}) {
  const { institutionId, year, divisionId, ctx, actor, summary } = params;
  const tt = await academicDb().schoolTimetable.findUnique({ where: { divisionId_academicYearId: { divisionId, academicYearId: year.id } }, select: { status: true } });
  if (tt?.status !== "PUBLISHED") return;
  const div = ctx.labels.division(divisionId);
  const [teachers, students] = await Promise.all([
    teacherUserIds(institutionId, params.teacherIds.filter((x): x is string => !!x)),
    divisionStudentUserIds(institutionId, divisionId, year.id),
  ]);
  notifyUsers({ institutionId, userIds: teachers, title: "Your timetable has been updated", message: `${div}: ${summary}`, tag: "TIMETABLE_UPDATED", sentById: actor.userId });
  notifyUsers({ institutionId, userIds: students, title: "Your timetable has been updated", message: summary, tag: "TIMETABLE_UPDATED", sentById: actor.userId });
}

// ── add ────────────────────────────────────────────────────────────────────────
export async function addEntry(institutionId: string, year: AcademicYear, divisionId: string, body: z.infer<typeof entryCreateSchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const timetable = await loadTimetableRow(institutionId, year, divisionId);
  if (timetable.status === "ARCHIVED") throw httpError(409, "This timetable is archived. Move it back to draft to edit.");
  const ctx = await loadYearContext(institutionId, year);
  const st = ctx.sessionTypes.get(body.sessionTypeId);
  const span = body.span ?? 1;
  const slots = consecutiveSlots(ctx.slots, body.slotId, span);
  if (!slots) throw httpError(400, span > 1 ? `Cannot fit ${span} consecutive periods starting here (a break or the end of the day is in the way).` : "Time slot not found");
  await validateRefs(institutionId, divisionId, ctx, body, year.id);

  // Fill defaults from the requirement / teaching assignment so the admin doesn't re-pick them.
  let teacherId = body.teacherId;
  let roomId = body.roomId;
  const cfg = body.configId ? await db.timetableSubjectConfig.findUnique({ where: { id: body.configId } }) : null;
  if (teacherId === undefined) {
    teacherId = cfg?.teacherId ?? (body.subjectId ? (await assignmentTeachers(institutionId, year.id, divisionId)).get(body.subjectId) ?? null : null);
    if (!st?.requiresTeacher) teacherId = null;
  }
  if (roomId === undefined) roomId = cfg?.roomId ?? null;

  const taken = await db.timetableEntry.findMany({
    where: { timetableId: timetable.id, dayOfWeek: body.dayOfWeek, slotId: { in: slots.map((s) => s.id) } },
    select: { id: true },
  });
  if (taken.length) throw httpError(409, "That slot already has a session. Remove it first, or move/swap instead.");

  const before = await loadYearEntries(institutionId, year.id);
  const groupId = slots.length > 1 ? randomUUID() : null;
  const created: EngineEntry[] = slots.map((s) => ({
    id: randomUUID(), divisionId, dayOfWeek: body.dayOfWeek, slotId: s.id, sessionTypeId: body.sessionTypeId,
    subjectId: body.subjectId ?? null, teacherId: teacherId ?? null, roomId: roomId ?? null,
    configId: body.configId ?? null, groupId, isLocked: false,
  }));
  const warnings = validateChange(ctx, before, [...before, ...created], created.map((c) => c.id), body.force);

  await db.timetableEntry.createMany({
    data: created.map((c) => ({
      id: c.id, institutionId, academicYearId: year.id, timetableId: timetable.id, divisionId, dayOfWeek: c.dayOfWeek, slotId: c.slotId,
      sessionTypeId: c.sessionTypeId, subjectId: c.subjectId, title: body.title ?? null, teacherId: c.teacherId, roomId: c.roomId,
      configId: c.configId, groupId: c.groupId,
    })),
  });
  audit(actor, "TIMETABLE_SESSION_ADDED", `Added ${st?.name ?? "session"} to ${ctx.labels.division(divisionId)} · ${describe(ctx, created[0])}`, {
    divisionId, academicYearId: year.id, entryIds: created.map((c) => c.id),
  });
  await notifyPublishedChange({ institutionId, year, divisionId, ctx, actor, teacherIds: [teacherId ?? null], summary: `${describe(ctx, created[0])} → ${st?.name ?? "Session"}${teacherId ? ` (${ctx.labels.teacher(teacherId)})` : ""}` });
  return { entries: await decorateEntries(institutionId, created.map((c) => c.id), ctx), warnings };
}

// ── edit teacher / room / subject / session ────────────────────────────────────
export async function updateEntry(institutionId: string, year: AcademicYear, id: string, patch: z.infer<typeof entryPatchSchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const entry = await loadEntryOrThrow(institutionId, year, id);
  const ctx = await loadYearContext(institutionId, year);
  await validateRefs(institutionId, entry.divisionId, ctx, patch, year.id);
  const ids = await groupOf(entry);
  const before = await loadYearEntries(institutionId, year.id);
  const after = before.map((e) =>
    ids.includes(e.id)
      ? {
          ...e,
          sessionTypeId: patch.sessionTypeId ?? e.sessionTypeId,
          subjectId: patch.subjectId === undefined ? e.subjectId : patch.subjectId,
          teacherId: patch.teacherId === undefined ? e.teacherId : patch.teacherId,
          roomId: patch.roomId === undefined ? e.roomId : patch.roomId,
        }
      : e
  );
  const warnings = validateChange(ctx, before, after, ids, patch.force);
  const oldTeacher = entry.teacherId;
  await db.timetableEntry.updateMany({
    where: { id: { in: ids } },
    data: {
      ...(patch.sessionTypeId ? { sessionTypeId: patch.sessionTypeId } : {}),
      ...(patch.subjectId !== undefined ? { subjectId: patch.subjectId } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.teacherId !== undefined ? { teacherId: patch.teacherId } : {}),
      ...(patch.roomId !== undefined ? { roomId: patch.roomId } : {}),
    },
  });
  const action = patch.teacherId !== undefined && patch.teacherId !== oldTeacher ? "TIMETABLE_TEACHER_CHANGED"
    : patch.roomId !== undefined && patch.roomId !== entry.roomId ? "TIMETABLE_ROOM_CHANGED" : "TIMETABLE_SESSION_UPDATED";
  audit(actor, action, `Updated ${ctx.labels.division(entry.divisionId)} · ${describe(ctx, entry)}`, {
    divisionId: entry.divisionId, academicYearId: year.id, entryIds: ids, fromTeacher: oldTeacher, toTeacher: patch.teacherId ?? oldTeacher,
  });
  const extra = patch.roomId !== undefined && patch.roomId !== entry.roomId ? `Room changed${patch.roomId ? `: ${ctx.labels.room(patch.roomId)}` : ""}` : "Updated";
  await notifyPublishedChange({ institutionId, year, divisionId: entry.divisionId, ctx, actor, teacherIds: [oldTeacher, patch.teacherId ?? oldTeacher], summary: `${describe(ctx, entry)} — ${extra}` });
  return { entries: await decorateEntries(institutionId, ids, ctx), warnings };
}

// ── delete / clear ─────────────────────────────────────────────────────────────
export async function deleteEntry(institutionId: string, year: AcademicYear, id: string, actor: Actor) {
  assertWritable(year);
  const entry = await loadEntryOrThrow(institutionId, year, id);
  if (entry.isLocked) throw httpError(409, "This session is locked. Unlock it before removing.");
  const ids = await groupOf(entry);
  const ctx = await loadYearContext(institutionId, year);
  await academicDb().timetableEntry.deleteMany({ where: { id: { in: ids } } });
  audit(actor, "TIMETABLE_SESSION_DELETED", `Removed session from ${ctx.labels.division(entry.divisionId)} · ${describe(ctx, entry)}`, {
    divisionId: entry.divisionId, academicYearId: year.id, entryIds: ids,
  });
  await notifyPublishedChange({ institutionId, year, divisionId: entry.divisionId, ctx, actor, teacherIds: [entry.teacherId], summary: `${describe(ctx, entry)} — session removed` });
  return { removed: ids };
}

/** A re-creatable description of entries (used by undo). Entries of one multi-period session share a groupKey. */
export interface EntrySnapshot {
  dayOfWeek: number; slotId: string; sessionTypeId: string; subjectId: string | null; title: string | null;
  teacherId: string | null; roomId: string | null; configId: string | null; groupKey: string | null; isLocked: boolean;
}
const snap = (e: {
  dayOfWeek: number; slotId: string; sessionTypeId: string; subjectId: string | null; title: string | null;
  teacherId: string | null; roomId: string | null; configId: string | null; groupId: string | null; isLocked: boolean;
}): EntrySnapshot => ({
  dayOfWeek: e.dayOfWeek, slotId: e.slotId, sessionTypeId: e.sessionTypeId, subjectId: e.subjectId, title: e.title,
  teacherId: e.teacherId, roomId: e.roomId, configId: e.configId, groupKey: e.groupId, isLocked: e.isLocked,
});

export async function clearDivision(institutionId: string, year: AcademicYear, divisionId: string, keepLocked: boolean, actor: Actor, dayOfWeek?: number) {
  assertWritable(year);
  const db = academicDb();
  const timetable = await loadTimetableRow(institutionId, year, divisionId);
  if (timetable.status === "PUBLISHED") throw httpError(409, "Unpublish the timetable before clearing it.");
  const where = { timetableId: timetable.id, ...(keepLocked ? { isLocked: false } : {}), ...(dayOfWeek ? { dayOfWeek } : {}) };
  const rows = await db.timetableEntry.findMany({ where });
  await db.timetableEntry.deleteMany({ where });
  audit(actor, "TIMETABLE_CLEARED", `Cleared ${dayOfWeek ? "one day of " : ""}the timetable of ${divisionId}`, { divisionId, academicYearId: year.id, removed: rows.length });
  return { removed: rows.length, snapshot: rows.map(snap) };
}

/** Delete several sessions at once (undo of an add / copy). Locked sessions are skipped, never deleted. */
export async function bulkDeleteEntries(institutionId: string, year: AcademicYear, body: z.infer<typeof bulkDeleteSchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const rows = await db.timetableEntry.findMany({ where: { id: { in: body.ids }, institutionId, academicYearId: year.id, isLocked: false } });
  if (!rows.length) return { removed: 0, snapshot: [] as EntrySnapshot[] };
  await db.timetableEntry.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  audit(actor, "TIMETABLE_SESSION_DELETED", `Removed ${rows.length} session(s)`, { divisionId: rows[0].divisionId, academicYearId: year.id, entryIds: rows.map((r) => r.id) });
  return { removed: rows.length, snapshot: rows.map(snap) };
}

/** Re-create sessions from snapshots (undo of delete / clear). The cells must be free. */
export async function restoreEntries(institutionId: string, year: AcademicYear, divisionId: string, body: z.infer<typeof restoreSchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const timetable = await loadTimetableRow(institutionId, year, divisionId);
  if (timetable.status === "ARCHIVED") throw httpError(409, "This timetable is archived. Move it back to draft to edit.");
  const ctx = await loadYearContext(institutionId, year);
  const slotIds = new Set(ctx.slots.map((s) => s.id));
  for (const e of body.entries) {
    if (!slotIds.has(e.slotId)) throw httpError(400, "A period no longer exists");
    await validateRefs(institutionId, divisionId, ctx, e, year.id);
  }
  const taken = await db.timetableEntry.findMany({
    where: { timetableId: timetable.id, OR: body.entries.map((e) => ({ dayOfWeek: e.dayOfWeek, slotId: e.slotId })) },
    select: { id: true },
  });
  if (taken.length) throw httpError(409, "Some of those slots are already filled, so the change can't be undone.");
  const groups = new Map<string, string>();
  const created: EngineEntry[] = body.entries.map((e) => {
    let groupId: string | null = null;
    if (e.groupKey) { groupId = groups.get(e.groupKey) ?? randomUUID(); groups.set(e.groupKey, groupId); }
    return {
      id: randomUUID(), divisionId, dayOfWeek: e.dayOfWeek, slotId: e.slotId, sessionTypeId: e.sessionTypeId, subjectId: e.subjectId ?? null,
      teacherId: e.teacherId ?? null, roomId: e.roomId ?? null, configId: e.configId ?? null, groupId, isLocked: !!e.isLocked,
    };
  });
  await db.timetableEntry.createMany({
    data: created.map((c, i) => ({
      id: c.id, institutionId, academicYearId: year.id, timetableId: timetable.id, divisionId, dayOfWeek: c.dayOfWeek, slotId: c.slotId,
      sessionTypeId: c.sessionTypeId, subjectId: c.subjectId, title: body.entries[i].title ?? null, teacherId: c.teacherId, roomId: c.roomId,
      configId: c.configId, groupId: c.groupId, isLocked: c.isLocked,
    })),
  });
  audit(actor, "TIMETABLE_SESSIONS_RESTORED", `Restored ${created.length} session(s) in ${ctx.labels.division(divisionId)}`, { divisionId, academicYearId: year.id, count: created.length });
  return { entries: await decorateEntries(institutionId, created.map((c) => c.id), ctx) };
}

/** Copy one weekday of a class onto other weekdays (new sessions; groups kept together; locked targets untouched). */
export async function copyDay(institutionId: string, year: AcademicYear, divisionId: string, body: z.infer<typeof copyDaySchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const timetable = await loadTimetableRow(institutionId, year, divisionId);
  if (timetable.status === "ARCHIVED") throw httpError(409, "This timetable is archived. Move it back to draft to edit.");
  const ctx = await loadYearContext(institutionId, year);
  const source = await db.timetableEntry.findMany({ where: { timetableId: timetable.id, dayOfWeek: body.fromDay } });
  if (!source.length) throw httpError(400, `${ctx.labels.day(body.fromDay)} has no sessions to copy.`);
  const targets = [...new Set(body.toDays)].filter((d) => d !== body.fromDay);
  if (!targets.length) throw httpError(400, "Choose at least one other day.");

  const existing = await db.timetableEntry.findMany({ where: { timetableId: timetable.id, dayOfWeek: { in: targets } } });
  const existingAt = new Map(existing.map((e) => [`${e.dayOfWeek}|${e.slotId}`, e]));
  const toDelete: string[] = [];
  const created: (EngineEntry & { title: string | null })[] = [];
  let skipped = 0;

  for (const day of targets) {
    // Whole multi-period sessions are copied or skipped together.
    const bySession = new Map<string, typeof source>();
    for (const e of source) {
      const k = e.groupId ?? e.id;
      bySession.set(k, [...(bySession.get(k) ?? []), e]);
    }
    for (const members of bySession.values()) {
      const blockers = members.map((m) => existingAt.get(`${day}|${m.slotId}`)).filter((x): x is NonNullable<typeof x> => !!x);
      if (blockers.length && (!body.overwrite || blockers.some((b) => b.isLocked))) { skipped++; continue; }
      for (const b of blockers) { if (!toDelete.includes(b.id)) toDelete.push(b.id); }
      const groupId = members.length > 1 ? randomUUID() : null;
      for (const m of members) {
        created.push({
          id: randomUUID(), divisionId, dayOfWeek: day, slotId: m.slotId, sessionTypeId: m.sessionTypeId, subjectId: m.subjectId,
          teacherId: m.teacherId, roomId: m.roomId, configId: m.configId, groupId, isLocked: false, title: m.title,
        });
      }
    }
  }
  if (!created.length) throw httpError(409, "Nothing was copied: the target days already have sessions in those periods.");

  const before = await loadYearEntries(institutionId, year.id);
  const after = [...before.filter((e) => !toDelete.includes(e.id)), ...created];
  const warnings = validateChange(ctx, before, after, created.map((c) => c.id), body.force);

  const removedRows = toDelete.length ? existing.filter((e) => toDelete.includes(e.id)) : [];
  await db.$transaction(async (tx) => {
    if (toDelete.length) await tx.timetableEntry.deleteMany({ where: { id: { in: toDelete } } });
    await tx.timetableEntry.createMany({
      data: created.map((c) => ({
        id: c.id, institutionId, academicYearId: year.id, timetableId: timetable.id, divisionId, dayOfWeek: c.dayOfWeek, slotId: c.slotId,
        sessionTypeId: c.sessionTypeId, subjectId: c.subjectId, title: c.title, teacherId: c.teacherId, roomId: c.roomId, configId: c.configId, groupId: c.groupId,
      })),
    });
  });
  audit(actor, "TIMETABLE_DAY_COPIED", `Copied ${ctx.labels.day(body.fromDay)} to ${targets.map(ctx.labels.day).join(", ")} for ${ctx.labels.division(divisionId)}`, {
    divisionId, academicYearId: year.id, created: created.length, overwritten: removedRows.length,
  });
  await notifyPublishedChange({ institutionId, year, divisionId, ctx, actor, teacherIds: created.map((c) => c.teacherId), summary: `${ctx.labels.day(body.fromDay)}'s schedule was copied to ${targets.map(ctx.labels.day).join(", ")}` });
  return { createdIds: created.map((c) => c.id), overwritten: removedRows.map(snap), skipped, warnings };
}

// ── move ───────────────────────────────────────────────────────────────────────
export async function moveEntry(institutionId: string, year: AcademicYear, body: z.infer<typeof entryMoveSchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const entry = await loadEntryOrThrow(institutionId, year, body.entryId);
  if (entry.isLocked) throw httpError(409, "This session is locked. Unlock it before moving.");
  const ctx = await loadYearContext(institutionId, year);
  const ids = await groupOf(entry);
  const members = await db.timetableEntry.findMany({ where: { id: { in: ids } }, include: { slot: true } });
  members.sort((a, b) => a.slot.order - b.slot.order);
  const targets = consecutiveSlots(ctx.slots, body.toSlotId, members.length);
  if (!targets) throw httpError(400, `Cannot fit ${members.length} consecutive periods starting at that slot.`);

  const occupied = await db.timetableEntry.findMany({
    where: { timetableId: entry.timetableId, dayOfWeek: body.toDayOfWeek, slotId: { in: targets.map((t) => t.id) }, id: { notIn: ids } },
    select: { id: true },
  });
  if (occupied.length) throw httpError(409, "The target slot is occupied. Use swap to exchange two sessions.");

  const before = await loadYearEntries(institutionId, year.id);
  const moves = new Map(members.map((m, i) => [m.id, { dayOfWeek: body.toDayOfWeek, slotId: targets[i].id }]));
  const after = before.map((e) => (moves.has(e.id) ? { ...e, ...moves.get(e.id)! } : e));
  const warnings = validateChange(ctx, before, after, ids, body.force);

  // Free the old cells first (day 0 never collides) so partially overlapping moves of one group are safe.
  await db.$transaction(async (tx) => {
    await tx.timetableEntry.updateMany({ where: { id: { in: ids } }, data: { dayOfWeek: 0 } });
    for (const m of members) await tx.timetableEntry.update({ where: { id: m.id }, data: moves.get(m.id)! });
  });
  audit(actor, "TIMETABLE_SESSION_MOVED", `Moved ${ctx.labels.division(entry.divisionId)} session from ${describe(ctx, entry)} to ${describe(ctx, { dayOfWeek: body.toDayOfWeek, slotId: body.toSlotId })}`, {
    divisionId: entry.divisionId, academicYearId: year.id, entryIds: ids,
  });
  await notifyPublishedChange({ institutionId, year, divisionId: entry.divisionId, ctx, actor, teacherIds: [entry.teacherId], summary: `Session moved from ${describe(ctx, entry)} to ${describe(ctx, { dayOfWeek: body.toDayOfWeek, slotId: body.toSlotId })}` });
  return { entries: await decorateEntries(institutionId, ids, ctx), warnings };
}

// ── swap ───────────────────────────────────────────────────────────────────────
export async function swapEntries(institutionId: string, year: AcademicYear, body: z.infer<typeof entrySwapSchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const a = await loadEntryOrThrow(institutionId, year, body.entryAId);
  const b = await loadEntryOrThrow(institutionId, year, body.entryBId);
  if (a.timetableId !== b.timetableId) throw httpError(400, "Sessions can only be swapped within the same class timetable.");
  if (a.isLocked || b.isLocked) throw httpError(409, "A locked session cannot be swapped. Unlock it first.");
  const aIds = await groupOf(a);
  const bIds = await groupOf(b);
  if (aIds.length !== bIds.length) throw httpError(400, "Swap needs sessions with the same number of periods.");
  if (aIds.some((x) => bIds.includes(x))) throw httpError(400, "Choose two different sessions.");
  const ctx = await loadYearContext(institutionId, year);
  const [am, bm] = await Promise.all([
    db.timetableEntry.findMany({ where: { id: { in: aIds } }, include: { slot: true } }),
    db.timetableEntry.findMany({ where: { id: { in: bIds } }, include: { slot: true } }),
  ]);
  am.sort((x, y) => x.slot.order - y.slot.order);
  bm.sort((x, y) => x.slot.order - y.slot.order);
  const coords = new Map<string, { dayOfWeek: number; slotId: string }>();
  am.forEach((m, i) => coords.set(m.id, { dayOfWeek: bm[i].dayOfWeek, slotId: bm[i].slotId }));
  bm.forEach((m, i) => coords.set(m.id, { dayOfWeek: am[i].dayOfWeek, slotId: am[i].slotId }));

  const before = await loadYearEntries(institutionId, year.id);
  const after = before.map((e) => (coords.has(e.id) ? { ...e, ...coords.get(e.id)! } : e));
  const warnings = validateChange(ctx, before, after, [...aIds, ...bIds], body.force);

  await db.$transaction(async (tx) => {
    // Park every entry on its own temporary negative day so same-period/different-day cells can't collide.
    for (const [i, id] of [...aIds, ...bIds].entries()) await tx.timetableEntry.update({ where: { id }, data: { dayOfWeek: -(i + 1) } });
    for (const [id, c] of coords) await tx.timetableEntry.update({ where: { id }, data: c });
  });
  audit(actor, "TIMETABLE_SESSION_SWAPPED", `Swapped sessions in ${ctx.labels.division(a.divisionId)}: ${describe(ctx, a)} ⇄ ${describe(ctx, b)}`, {
    divisionId: a.divisionId, academicYearId: year.id, entryIds: [...aIds, ...bIds],
  });
  await notifyPublishedChange({ institutionId, year, divisionId: a.divisionId, ctx, actor, teacherIds: [a.teacherId, b.teacherId], summary: `Sessions swapped: ${describe(ctx, a)} ⇄ ${describe(ctx, b)}` });
  return { entries: await decorateEntries(institutionId, [...aIds, ...bIds], ctx), warnings };
}

// ── lock / unlock ──────────────────────────────────────────────────────────────
export async function setLocked(institutionId: string, year: AcademicYear, id: string, locked: boolean, actor: Actor) {
  assertWritable(year);
  const entry = await loadEntryOrThrow(institutionId, year, id);
  const ids = await groupOf(entry);
  await academicDb().timetableEntry.updateMany({ where: { id: { in: ids } }, data: { isLocked: locked } });
  audit(actor, locked ? "TIMETABLE_SESSION_LOCKED" : "TIMETABLE_SESSION_UNLOCKED", `${locked ? "Locked" : "Unlocked"} a session`, {
    divisionId: entry.divisionId, academicYearId: year.id, entryIds: ids,
  });
  return { ids, isLocked: locked };
}

// ── whole-school sessions (assembly etc.) ──────────────────────────────────────
export async function applyToAll(institutionId: string, year: AcademicYear, body: z.infer<typeof applyToAllSchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const ctx = await loadYearContext(institutionId, year);
  if (!ctx.sessionTypes.has(body.sessionTypeId)) throw httpError(400, "Unknown session type");
  if (!ctx.slots.some((s) => s.id === body.slotId)) throw httpError(400, "Time slot not found");
  const days = body.days?.length ? body.days : body.dayOfWeek ? [body.dayOfWeek] : ctx.workingDays;
  const divisions = await db.division.findMany({
    where: { institutionId, ...(body.standardId ? { standardId: body.standardId } : {}) },
    select: { id: true },
  });
  if (!divisions.length) throw httpError(404, "No classes found");

  const before = await loadYearEntries(institutionId, year.id);
  const created: { id: string; divisionId: string; dayOfWeek: number; timetableId: string }[] = [];
  const skipped: string[] = [];
  for (const d of divisions) {
    const tt = await getOrCreateTimetable(institutionId, year, d.id);
    if (tt.status === "ARCHIVED") continue;
    for (const day of days) {
      const taken = before.some((e) => e.divisionId === d.id && e.dayOfWeek === day && e.slotId === body.slotId);
      if (taken) { skipped.push(`${ctx.labels.division(d.id)} ${ctx.labels.day(day)}`); continue; }
      created.push({ id: randomUUID(), divisionId: d.id, dayOfWeek: day, timetableId: tt.id });
    }
  }
  const proposed: EngineEntry[] = created.map((c) => ({
    id: c.id, divisionId: c.divisionId, dayOfWeek: c.dayOfWeek, slotId: body.slotId, sessionTypeId: body.sessionTypeId,
    subjectId: null, teacherId: null, roomId: null, configId: null, groupId: null, isLocked: false,
  }));
  const warnings = validateChange(ctx, before, [...before, ...proposed], proposed.map((p) => p.id), body.force);
  await db.timetableEntry.createMany({
    data: created.map((c) => ({
      id: c.id, institutionId, academicYearId: year.id, timetableId: c.timetableId, divisionId: c.divisionId, dayOfWeek: c.dayOfWeek,
      slotId: body.slotId, sessionTypeId: body.sessionTypeId, title: body.title ?? null,
    })),
  });
  audit(actor, "TIMETABLE_BULK_SESSION_ADDED", `Applied ${ctx.sessionTypes.get(body.sessionTypeId)?.name} to ${divisions.length} classes`, {
    academicYearId: year.id, created: created.length, skipped: skipped.length,
  });
  return { created: created.length, skipped, warnings };
}
