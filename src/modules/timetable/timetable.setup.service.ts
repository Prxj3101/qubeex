import { z } from "zod";
import type { AcademicYear } from "../../generated/prisma/client";
import { Prisma } from "../../generated/prisma/client";
import { academicDb } from "../../utils/academicContext";
import { assertWritable, ensureSessionTypes, httpError, loadYearContext } from "./timetable.common";
import {
  availabilitySchema, cellsSchema, roomPatchSchema, roomSchema, sessionTypePatchSchema, sessionTypeSchema,
  slotBodySchema, slotPatchSchema, teacherPrefSchema,
} from "./timetable.schema";

type SlotBody = z.infer<typeof slotBodySchema>;

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// ── Setup bundle ───────────────────────────────────────────────────────────────
export async function getSetup(institutionId: string, year: AcademicYear) {
  const ctx = await loadYearContext(institutionId, year);
  const db = academicDb();
  const [settings, prefs, subjectRows] = await Promise.all([
    db.timetableSettings.findUnique({ where: { institutionId_academicYearId: { institutionId, academicYearId: year.id } } }),
    db.teacherTimetablePref.findMany({ where: { institutionId, academicYearId: year.id } }),
    db.subject.findMany({ where: { institutionId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  // Same-named subjects of different classes are one subject for the "where is Maths taught" view.
  const seen = new Set<string>();
  const subjects = subjectRows.filter((s) => {
    const k = s.name.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    academicYear: { id: year.id, label: year.label, status: year.status, isCurrent: year.isCurrent },
    writable: year.status === "ACTIVE",
    configured: !!settings,
    workingDays: ctx.workingDays,
    slots: ctx.slots,
    sessionTypes: [...ctx.sessionTypes.values()],
    rooms: [...ctx.rooms.values()],
    teachers: ctx.teachers.map((t) => ({ id: t.id, name: t.name })),
    subjects,
    teacherPrefs: prefs.map((p) => ({
      teacherId: p.teacherId, maxPeriodsPerDay: p.maxPeriodsPerDay, maxConsecutive: p.maxConsecutive, maxPeriodsPerWeek: p.maxPeriodsPerWeek,
    })),
  };
}

// ── Working days ───────────────────────────────────────────────────────────────
export async function setWorkingDays(institutionId: string, year: AcademicYear, workingDays: number[]) {
  assertWritable(year);
  const sorted = [...workingDays].sort((a, b) => a - b);
  await academicDb().timetableSettings.upsert({
    where: { institutionId_academicYearId: { institutionId, academicYearId: year.id } },
    create: { institutionId, academicYearId: year.id, workingDays: sorted },
    update: { workingDays: sorted },
  });
  return { workingDays: sorted };
}

// ── Time slots ─────────────────────────────────────────────────────────────────
async function assertNoOverlap(institutionId: string, yearId: string, start: number, end: number, ignoreId?: string) {
  const clash = await academicDb().timeSlot.findFirst({
    where: {
      institutionId, academicYearId: yearId,
      ...(ignoreId ? { id: { not: ignoreId } } : {}),
      startMinute: { lt: end }, endMinute: { gt: start },
    },
    select: { name: true },
  });
  if (clash) throw httpError(409, `Overlaps with "${clash.name}". Time slots cannot overlap.`);
}

export async function createSlot(institutionId: string, year: AcademicYear, body: SlotBody) {
  assertWritable(year);
  await assertNoOverlap(institutionId, year.id, body.startMinute, body.endMinute);
  const db = academicDb();
  // New slot goes in chronological position; later slots shift down by one.
  const slots = await db.timeSlot.findMany({ where: { institutionId, academicYearId: year.id }, orderBy: { order: "asc" } });
  const insertAt = slots.filter((s) => s.startMinute < body.startMinute).length;
  return db.$transaction(async (tx) => {
    // Two-step shift avoids the (institution, year, order) unique index tripping mid-update.
    const later = slots.slice(insertAt);
    for (const s of later) await tx.timeSlot.update({ where: { id: s.id }, data: { order: s.order + 1000 } });
    for (const s of later) await tx.timeSlot.update({ where: { id: s.id }, data: { order: s.order + 1 } });
    return tx.timeSlot.create({
      data: { institutionId, academicYearId: year.id, name: body.name, order: insertAt + 1, startMinute: body.startMinute, endMinute: body.endMinute, kind: body.kind },
    });
  });
}

export async function updateSlot(institutionId: string, year: AcademicYear, id: string, patch: z.infer<typeof slotPatchSchema>) {
  assertWritable(year);
  const db = academicDb();
  const slot = await db.timeSlot.findFirst({ where: { id, institutionId, academicYearId: year.id } });
  if (!slot) throw httpError(404, "Time slot not found");
  const start = patch.startMinute ?? slot.startMinute;
  const end = patch.endMinute ?? slot.endMinute;
  if (end <= start) throw httpError(400, "End time must be after start time");
  await assertNoOverlap(institutionId, year.id, start, end, id);
  if (patch.kind && patch.kind !== "PERIOD" && slot.kind === "PERIOD") {
    const used = await db.timetableEntry.count({ where: { slotId: id } });
    if (used > 0) throw httpError(409, "This period still has timetable entries. Clear them before turning it into a break.");
  }
  return db.timeSlot.update({ where: { id }, data: { name: patch.name, startMinute: start, endMinute: end, kind: patch.kind } });
}

export async function deleteSlot(institutionId: string, year: AcademicYear, id: string) {
  assertWritable(year);
  const db = academicDb();
  const slot = await db.timeSlot.findFirst({ where: { id, institutionId, academicYearId: year.id } });
  if (!slot) throw httpError(404, "Time slot not found");
  const used = await db.timetableEntry.count({ where: { slotId: id } });
  if (used > 0) throw httpError(409, `${used} timetable entr${used === 1 ? "y uses" : "ies use"} this period. Clear them first.`);
  await db.$transaction(async (tx) => {
    await tx.timeSlot.delete({ where: { id } });
    const rest = await tx.timeSlot.findMany({ where: { institutionId, academicYearId: year.id }, orderBy: { order: "asc" } });
    for (const [i, s] of rest.entries()) if (s.order !== i + 1) await tx.timeSlot.update({ where: { id: s.id }, data: { order: i + 1 + 1000 } });
    for (const [i, s] of rest.entries()) if (s.order !== i + 1) await tx.timeSlot.update({ where: { id: s.id }, data: { order: i + 1 } });
  });
}

export async function reorderSlots(institutionId: string, year: AcademicYear, orderedIds: string[]) {
  assertWritable(year);
  const db = academicDb();
  const slots = await db.timeSlot.findMany({ where: { institutionId, academicYearId: year.id }, select: { id: true } });
  if (slots.length !== orderedIds.length || !slots.every((s) => orderedIds.includes(s.id))) {
    throw httpError(400, "orderedIds must list every time slot exactly once");
  }
  await db.$transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) await tx.timeSlot.update({ where: { id }, data: { order: i + 1 + 1000 } });
    for (const [i, id] of orderedIds.entries()) await tx.timeSlot.update({ where: { id }, data: { order: i + 1 } });
  });
}

/** Clone working days, slots, and per-teacher/room availability + prefs from another year. */
export async function copyFromYear(institutionId: string, year: AcademicYear, fromYearId: string) {
  assertWritable(year);
  const db = academicDb();
  const from = await db.academicYear.findFirst({ where: { id: fromYearId, institutionId } });
  if (!from) throw httpError(404, "Source academic year not found");
  if (from.id === year.id) throw httpError(400, "Choose a different year to copy from");
  const existing = await db.timeSlot.count({ where: { institutionId, academicYearId: year.id } });
  if (existing > 0) throw httpError(409, "This year already has periods configured. Delete them first to copy.");

  const [settings, slots, tAvail, rUnavail, prefs] = await Promise.all([
    db.timetableSettings.findUnique({ where: { institutionId_academicYearId: { institutionId, academicYearId: from.id } } }),
    db.timeSlot.findMany({ where: { institutionId, academicYearId: from.id }, orderBy: { order: "asc" } }),
    db.teacherAvailability.findMany({ where: { institutionId, academicYearId: from.id } }),
    db.roomUnavailability.findMany({ where: { institutionId, academicYearId: from.id } }),
    db.teacherTimetablePref.findMany({ where: { institutionId, academicYearId: from.id } }),
  ]);
  if (slots.length === 0) throw httpError(404, `${from.label} has no periods configured`);

  await db.$transaction(async (tx) => {
    if (settings) {
      await tx.timetableSettings.upsert({
        where: { institutionId_academicYearId: { institutionId, academicYearId: year.id } },
        create: { institutionId, academicYearId: year.id, workingDays: settings.workingDays },
        update: { workingDays: settings.workingDays },
      });
    }
    const map = new Map<string, string>();
    for (const s of slots) {
      const created = await tx.timeSlot.create({
        data: { institutionId, academicYearId: year.id, name: s.name, order: s.order, startMinute: s.startMinute, endMinute: s.endMinute, kind: s.kind },
      });
      map.set(s.id, created.id);
    }
    await tx.teacherAvailability.createMany({
      data: tAvail.filter((a) => map.has(a.slotId)).map((a) => ({
        institutionId, academicYearId: year.id, teacherId: a.teacherId, dayOfWeek: a.dayOfWeek, slotId: map.get(a.slotId)!, kind: a.kind,
      })),
      skipDuplicates: true,
    });
    await tx.roomUnavailability.createMany({
      data: rUnavail.filter((a) => map.has(a.slotId)).map((a) => ({
        institutionId, academicYearId: year.id, roomId: a.roomId, dayOfWeek: a.dayOfWeek, slotId: map.get(a.slotId)!,
      })),
      skipDuplicates: true,
    });
    await tx.teacherTimetablePref.createMany({
      data: prefs.map((p) => ({
        institutionId, academicYearId: year.id, teacherId: p.teacherId,
        maxPeriodsPerDay: p.maxPeriodsPerDay, maxConsecutive: p.maxConsecutive, maxPeriodsPerWeek: p.maxPeriodsPerWeek,
      })),
      skipDuplicates: true,
    });
  });
  return { copiedSlots: slots.length };
}

// ── Session types ──────────────────────────────────────────────────────────────
export async function listSessionTypes(institutionId: string) {
  return ensureSessionTypes(institutionId);
}

export async function createSessionType(institutionId: string, body: z.infer<typeof sessionTypeSchema>) {
  try {
    return await academicDb().timetableSessionType.create({
      data: { institutionId, ...body, roomType: body.roomType || null, color: body.color ?? null },
    });
  } catch (e) {
    if (isUnique(e)) throw httpError(409, "A session type with this name already exists");
    throw e;
  }
}

export async function updateSessionType(institutionId: string, id: string, patch: z.infer<typeof sessionTypePatchSchema>) {
  const db = academicDb();
  const existing = await db.timetableSessionType.findFirst({ where: { id, institutionId } });
  if (!existing) throw httpError(404, "Session type not found");
  try {
    return await db.timetableSessionType.update({
      where: { id },
      data: { ...patch, roomType: patch.roomType === undefined ? undefined : patch.roomType || null },
    });
  } catch (e) {
    if (isUnique(e)) throw httpError(409, "A session type with this name already exists");
    throw e;
  }
}

export async function deleteSessionType(institutionId: string, id: string) {
  const db = academicDb();
  const existing = await db.timetableSessionType.findFirst({ where: { id, institutionId } });
  if (!existing) throw httpError(404, "Session type not found");
  const [configs, entries, exceptions] = await Promise.all([
    db.timetableSubjectConfig.count({ where: { sessionTypeId: id } }),
    db.timetableEntry.count({ where: { sessionTypeId: id } }),
    db.timetableException.count({ where: { sessionTypeId: id } }),
  ]);
  if (configs + entries + exceptions > 0) {
    throw httpError(409, "This session type is in use. Deactivate it instead of deleting.");
  }
  await db.timetableSessionType.delete({ where: { id } });
}

// ── Rooms ──────────────────────────────────────────────────────────────────────
export async function createRoom(institutionId: string, body: z.infer<typeof roomSchema>) {
  try {
    return await academicDb().room.create({
      data: { institutionId, name: body.name, type: body.type, capacity: body.capacity ?? null, isActive: body.isActive ?? true, notes: body.notes ?? null },
    });
  } catch (e) {
    if (isUnique(e)) throw httpError(409, "A room with this name already exists");
    throw e;
  }
}

export async function updateRoom(institutionId: string, id: string, patch: z.infer<typeof roomPatchSchema>) {
  const db = academicDb();
  const existing = await db.room.findFirst({ where: { id, institutionId } });
  if (!existing) throw httpError(404, "Room not found");
  try {
    return await db.room.update({ where: { id }, data: patch });
  } catch (e) {
    if (isUnique(e)) throw httpError(409, "A room with this name already exists");
    throw e;
  }
}

export async function deleteRoom(institutionId: string, id: string) {
  const db = academicDb();
  const existing = await db.room.findFirst({ where: { id, institutionId } });
  if (!existing) throw httpError(404, "Room not found");
  const [entries, configs] = await Promise.all([
    db.timetableEntry.count({ where: { roomId: id } }),
    db.timetableSubjectConfig.count({ where: { roomId: id } }),
  ]);
  if (entries + configs > 0) throw httpError(409, "This room is used in a timetable. Deactivate it instead of deleting.");
  await db.room.delete({ where: { id } });
}

async function validSlotIds(institutionId: string, yearId: string, cells: { slotId: string }[]) {
  const ids = [...new Set(cells.map((c) => c.slotId))];
  if (!ids.length) return;
  const found = await academicDb().timeSlot.count({ where: { id: { in: ids }, institutionId, academicYearId: yearId } });
  if (found !== ids.length) throw httpError(400, "One or more periods do not belong to this academic year");
}

export async function getRoomUnavailability(institutionId: string, year: AcademicYear, roomId: string) {
  const db = academicDb();
  const room = await db.room.findFirst({ where: { id: roomId, institutionId }, select: { id: true } });
  if (!room) throw httpError(404, "Room not found");
  const rows = await db.roomUnavailability.findMany({ where: { institutionId, academicYearId: year.id, roomId } });
  return rows.map((r) => ({ dayOfWeek: r.dayOfWeek, slotId: r.slotId }));
}

export async function setRoomUnavailability(institutionId: string, year: AcademicYear, roomId: string, body: z.infer<typeof cellsSchema>) {
  assertWritable(year);
  const db = academicDb();
  const room = await db.room.findFirst({ where: { id: roomId, institutionId }, select: { id: true } });
  if (!room) throw httpError(404, "Room not found");
  await validSlotIds(institutionId, year.id, body.cells);
  await db.$transaction([
    db.roomUnavailability.deleteMany({ where: { institutionId, academicYearId: year.id, roomId } }),
    db.roomUnavailability.createMany({
      data: body.cells.map((c) => ({ institutionId, academicYearId: year.id, roomId, dayOfWeek: c.dayOfWeek, slotId: c.slotId })),
      skipDuplicates: true,
    }),
  ]);
}

// ── Teacher availability / prefs ───────────────────────────────────────────────
async function assertTeacher(institutionId: string, teacherId: string) {
  const t = await academicDb().teacher.findFirst({ where: { id: teacherId, institutionId }, select: { id: true } });
  if (!t) throw httpError(404, "Teacher not found");
}

export async function getTeacherAvailability(institutionId: string, year: AcademicYear, teacherId: string) {
  await assertTeacher(institutionId, teacherId);
  const db = academicDb();
  const [rows, pref] = await Promise.all([
    db.teacherAvailability.findMany({ where: { institutionId, academicYearId: year.id, teacherId } }),
    db.teacherTimetablePref.findUnique({ where: { teacherId_academicYearId: { teacherId, academicYearId: year.id } } }),
  ]);
  return {
    unavailable: rows.filter((r) => r.kind === "UNAVAILABLE").map((r) => ({ dayOfWeek: r.dayOfWeek, slotId: r.slotId })),
    preferred: rows.filter((r) => r.kind === "PREFERRED").map((r) => ({ dayOfWeek: r.dayOfWeek, slotId: r.slotId })),
    prefs: pref
      ? { maxPeriodsPerDay: pref.maxPeriodsPerDay, maxConsecutive: pref.maxConsecutive, maxPeriodsPerWeek: pref.maxPeriodsPerWeek }
      : { maxPeriodsPerDay: null, maxConsecutive: null, maxPeriodsPerWeek: null },
  };
}

export async function setTeacherAvailability(institutionId: string, year: AcademicYear, teacherId: string, body: z.infer<typeof availabilitySchema>) {
  assertWritable(year);
  await assertTeacher(institutionId, teacherId);
  await validSlotIds(institutionId, year.id, [...body.unavailable, ...body.preferred]);
  const unavailKeys = new Set(body.unavailable.map((c) => `${c.dayOfWeek}|${c.slotId}`));
  const preferred = body.preferred.filter((c) => !unavailKeys.has(`${c.dayOfWeek}|${c.slotId}`));
  const db = academicDb();
  await db.$transaction([
    db.teacherAvailability.deleteMany({ where: { institutionId, academicYearId: year.id, teacherId } }),
    db.teacherAvailability.createMany({
      data: [
        ...body.unavailable.map((c) => ({ institutionId, academicYearId: year.id, teacherId, dayOfWeek: c.dayOfWeek, slotId: c.slotId, kind: "UNAVAILABLE" as const })),
        ...preferred.map((c) => ({ institutionId, academicYearId: year.id, teacherId, dayOfWeek: c.dayOfWeek, slotId: c.slotId, kind: "PREFERRED" as const })),
      ],
      skipDuplicates: true,
    }),
  ]);
}

export async function setTeacherPrefs(institutionId: string, year: AcademicYear, teacherId: string, body: z.infer<typeof teacherPrefSchema>) {
  assertWritable(year);
  await assertTeacher(institutionId, teacherId);
  await academicDb().teacherTimetablePref.upsert({
    where: { teacherId_academicYearId: { teacherId, academicYearId: year.id } },
    create: { institutionId, academicYearId: year.id, teacherId, ...body },
    update: body,
  });
}
