import { randomUUID } from "crypto";
import { z } from "zod";
import type { AcademicYear } from "../../generated/prisma/client";
import { academicDb } from "../../utils/academicContext";
import {
  assertWritable, httpError, loadYearContext, loadYearEntries, type YearContext,
} from "./timetable.common";
import {
  detectConflicts, requirementStatus, type Conflict, type EngineConfig, type EngineEntry,
} from "./timetable.engine";
import { configsSchema, copyConfigsSchema } from "./timetable.schema";

export async function assertDivision(institutionId: string, divisionId: string) {
  const division = await academicDb().division.findFirst({
    where: { id: divisionId, institutionId },
    select: { id: true, name: true, standardId: true, classTeacherId: true, standard: { select: { name: true } } },
  });
  if (!division) throw httpError(404, "Class/section not found");
  return division;
}

export async function getOrCreateTimetable(institutionId: string, year: AcademicYear, divisionId: string) {
  const db = academicDb();
  const existing = await db.schoolTimetable.findUnique({ where: { divisionId_academicYearId: { divisionId, academicYearId: year.id } } });
  if (existing) return existing;
  assertWritable(year);
  return db.schoolTimetable.create({ data: { institutionId, academicYearId: year.id, divisionId } });
}

/** Teacher assigned to teach `subjectId` in `divisionId` for the year (DivisionAssignment). */
export async function assignmentTeachers(institutionId: string, yearId: string, divisionId: string): Promise<Map<string, string>> {
  const rows = await academicDb().divisionAssignment.findMany({
    where: { institutionId, academicYearId: yearId, divisionId, subjectId: { not: null } },
    select: { subjectId: true, teacherId: true },
    orderBy: { createdAt: "asc" },
  });
  const map = new Map<string, string>();
  for (const r of rows) if (r.subjectId && !map.has(r.subjectId)) map.set(r.subjectId, r.teacherId);
  return map;
}

export async function loadEngineConfigs(
  institutionId: string, yearId: string, divisionIds: string[]
): Promise<EngineConfig[]> {
  const db = academicDb();
  const rows = await db.timetableSubjectConfig.findMany({
    where: { institutionId, academicYearId: yearId, divisionId: { in: divisionIds } },
    include: { subject: { select: { name: true } }, sessionType: { select: { name: true, isActive: true } } },
    orderBy: { createdAt: "asc" },
  });
  const assignByDiv = new Map<string, Map<string, string>>();
  for (const d of new Set(rows.map((r) => r.divisionId))) assignByDiv.set(d, await assignmentTeachers(institutionId, yearId, d));
  return rows.map((r) => {
    const base = r.subject?.name ?? r.title ?? r.sessionType.name;
    const sessionName = r.sessionType.name;
    const label = r.subject && sessionName !== "Theory" ? `${base} ${sessionName}` : base;
    const resolved = r.teacherId ?? (r.subjectId ? assignByDiv.get(r.divisionId)?.get(r.subjectId) ?? null : null);
    return {
      id: r.id, divisionId: r.divisionId, subjectId: r.subjectId, sessionTypeId: r.sessionTypeId, label,
      periodsPerWeek: r.periodsPerWeek, span: r.span, maxPerDay: r.maxPerDay,
      teacherId: resolved, roomId: r.roomId, roomType: r.roomType,
    };
  });
}

export async function decorateEntries(institutionId: string, entryIds: string[] | { divisionId: string; academicYearId: string }, ctx: YearContext) {
  const where = Array.isArray(entryIds)
    ? { id: { in: entryIds }, institutionId }
    : { divisionId: entryIds.divisionId, academicYearId: entryIds.academicYearId, institutionId };
  const rows = await academicDb().timetableEntry.findMany({
    where,
    include: { subject: { select: { name: true, color: true } } },
    orderBy: [{ dayOfWeek: "asc" }, { slot: { order: "asc" } }],
  });
  return rows.map((e) => {
    const st = ctx.sessionTypes.get(e.sessionTypeId);
    return {
      id: e.id, divisionId: e.divisionId, dayOfWeek: e.dayOfWeek, slotId: e.slotId,
      sessionTypeId: e.sessionTypeId, sessionTypeName: st?.name ?? "", sessionKind: st?.kind ?? "CUSTOM", color: e.subject?.color ?? st?.color ?? null,
      subjectId: e.subjectId, subjectName: e.subject?.name ?? null, title: e.title,
      teacherId: e.teacherId, teacherName: e.teacherId ? ctx.labels.teacher(e.teacherId) : null,
      roomId: e.roomId, roomName: e.roomId ? ctx.labels.room(e.roomId) : null,
      configId: e.configId, groupId: e.groupId, isLocked: e.isLocked,
    };
  });
}

export function yearConflicts(ctx: YearContext, entries: EngineEntry[], configs?: EngineConfig[]): Conflict[] {
  return detectConflicts({
    entries, slots: ctx.slots, workingDays: ctx.workingDays, sessionTypes: ctx.sessionTypes, rooms: ctx.rooms,
    teacherUnavailable: ctx.teacherUnavailable, roomUnavailable: ctx.roomUnavailable, teacherPrefs: ctx.teacherPrefs,
    configs, labels: ctx.labels,
  });
}

const involvesDivision = (c: Conflict, divisionId: string) =>
  c.divisionId === divisionId || c.cells.some((x) => x.divisionId === divisionId);

export async function getDivisionStudio(institutionId: string, year: AcademicYear, divisionId: string) {
  const db = academicDb();
  const division = await assertDivision(institutionId, divisionId);
  const ctx = await loadYearContext(institutionId, year);
  const timetable = year.status === "ACTIVE"
    ? await getOrCreateTimetable(institutionId, year, divisionId)
    : await db.schoolTimetable.findUnique({ where: { divisionId_academicYearId: { divisionId, academicYearId: year.id } } });

  const [allEntries, configs, subjectRows, lastGen, assignments] = await Promise.all([
    loadYearEntries(institutionId, year.id),
    loadEngineConfigs(institutionId, year.id, [divisionId]),
    db.divisionSubject.findMany({
      where: { divisionId, institutionId },
      select: { subject: { select: { id: true, name: true, color: true, order: true } } },
    }),
    timetable
      ? db.timetableGeneration.findFirst({ where: { timetableId: timetable.id }, orderBy: { createdAt: "desc" } })
      : Promise.resolve(null),
    assignmentTeachers(institutionId, year.id, divisionId),
  ]);

  const divisionEntries = allEntries.filter((e) => e.divisionId === divisionId);
  const conflicts = yearConflicts(ctx, allEntries, configs).filter((c) => involvesDivision(c, divisionId));
  const rawConfigs = await db.timetableSubjectConfig.findMany({
    where: { institutionId, academicYearId: year.id, divisionId },
    include: { subject: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const resolvedById = new Map(configs.map((c) => [c.id, c]));
  const siblings = await db.division.findMany({
    where: { institutionId, standardId: division.standardId, id: { not: divisionId } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return {
    academicYear: { id: year.id, label: year.label, status: year.status, isCurrent: year.isCurrent },
    writable: year.status === "ACTIVE",
    division: { id: division.id, name: division.name, standardId: division.standardId, standardName: division.standard.name, classTeacherId: division.classTeacherId },
    siblings: siblings.map((x) => ({ id: x.id, label: ctx.labels.division(x.id) })),
    timetable: timetable
      ? { id: timetable.id, status: timetable.status, generatedAt: timetable.generatedAt, publishedAt: timetable.publishedAt }
      : null,
    workingDays: ctx.workingDays,
    slots: ctx.slots,
    entries: timetable ? await decorateEntries(institutionId, { divisionId, academicYearId: year.id }, ctx) : [],
    configs: rawConfigs.map((c) => ({
      id: c.id, subjectId: c.subjectId, subjectName: c.subject?.name ?? null, sessionTypeId: c.sessionTypeId, title: c.title,
      periodsPerWeek: c.periodsPerWeek, span: c.span, maxPerDay: c.maxPerDay, teacherId: c.teacherId, roomId: c.roomId, roomType: c.roomType,
      resolvedTeacherId: resolvedById.get(c.id)?.teacherId ?? null,
      resolvedTeacherName: resolvedById.get(c.id)?.teacherId ? ctx.labels.teacher(resolvedById.get(c.id)!.teacherId!) : null,
      label: resolvedById.get(c.id)?.label ?? "",
    })),
    requirements: requirementStatus(configs, divisionEntries),
    conflicts,
    subjects: subjectRows.map((r) => r.subject).sort((a, b) => a.order - b.order).map((s) => ({
      id: s.id, name: s.name, color: s.color, defaultTeacherId: assignments.get(s.id) ?? null,
    })),
    sessionTypes: [...ctx.sessionTypes.values()],
    rooms: [...ctx.rooms.values()],
    teachers: ctx.teachers.map((t) => ({ id: t.id, name: t.name })),
    lastGeneration: lastGen
      ? { complete: lastGen.complete, placed: lastGen.placed, unplaced: lastGen.unplaced, problems: (lastGen.problems as string[] | null) ?? [], createdAt: lastGen.createdAt }
      : null,
  };
}

/** Replace a division's weekly requirements. Existing ids are updated in place so entries keep their config link. */
export async function saveConfigs(institutionId: string, year: AcademicYear, divisionId: string, body: z.infer<typeof configsSchema>) {
  assertWritable(year);
  const db = academicDb();
  const division = await assertDivision(institutionId, divisionId);
  const ctx = await loadYearContext(institutionId, year);

  const subjectIds = [...new Set(body.configs.map((c) => c.subjectId).filter((x): x is string => !!x))];
  if (subjectIds.length) {
    const ok = await db.subject.count({ where: { id: { in: subjectIds }, institutionId, standardId: division.standardId } });
    if (ok !== subjectIds.length) throw httpError(400, "A subject does not belong to this class");
  }
  const teacherIds = [...new Set(body.configs.map((c) => c.teacherId).filter((x): x is string => !!x))];
  if (teacherIds.length) {
    const ok = await db.teacher.count({ where: { id: { in: teacherIds }, institutionId } });
    if (ok !== teacherIds.length) throw httpError(400, "A teacher was not found");
  }
  const roomIds = [...new Set(body.configs.map((c) => c.roomId).filter((x): x is string => !!x))];
  if (roomIds.length) {
    const ok = await db.room.count({ where: { id: { in: roomIds }, institutionId } });
    if (ok !== roomIds.length) throw httpError(400, "A room was not found");
  }
  for (const c of body.configs) {
    if (!ctx.sessionTypes.has(c.sessionTypeId)) throw httpError(400, "Unknown session type");
    if (!c.subjectId && !c.title) throw httpError(400, "Each requirement needs a subject or a title");
    if (c.span > c.periodsPerWeek) throw httpError(400, "Consecutive periods cannot exceed periods per week");
  }

  const timetable = await getOrCreateTimetable(institutionId, year, divisionId);
  const existing = await db.timetableSubjectConfig.findMany({ where: { institutionId, academicYearId: year.id, divisionId }, select: { id: true } });
  const keep = new Set(body.configs.map((c) => c.id).filter((x): x is string => !!x && existing.some((e) => e.id === x)));
  const removed = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);

  await db.$transaction(async (tx) => {
    if (removed.length) await tx.timetableSubjectConfig.deleteMany({ where: { id: { in: removed } } });
    for (const c of body.configs) {
      const data = {
        subjectId: c.subjectId ?? null, sessionTypeId: c.sessionTypeId, title: c.title ?? null,
        periodsPerWeek: c.periodsPerWeek, span: c.span, maxPerDay: c.maxPerDay,
        teacherId: c.teacherId ?? null, roomId: c.roomId ?? null, roomType: c.roomType || null,
      };
      if (c.id && keep.has(c.id)) await tx.timetableSubjectConfig.update({ where: { id: c.id }, data });
      else await tx.timetableSubjectConfig.create({ data: { id: randomUUID(), institutionId, academicYearId: year.id, divisionId, ...data } });
    }
  });
  return { timetableId: timetable.id };
}

export async function getYearConflicts(institutionId: string, year: AcademicYear, divisionId?: string) {
  const ctx = await loadYearContext(institutionId, year);
  const [entries, divisions] = await Promise.all([
    loadYearEntries(institutionId, year.id),
    academicDb().division.findMany({ where: { institutionId }, select: { id: true } }),
  ]);
  const configs = await loadEngineConfigs(institutionId, year.id, divisions.map((d) => d.id));
  const all = yearConflicts(ctx, entries, configs);
  return divisionId ? all.filter((c) => involvesDivision(c, divisionId)) : all;
}

/**
 * Copy one section's weekly requirements to the other sections of the same class, so a class is set up
 * once instead of once per section. Matching rows (same subject + session type + title) are updated in
 * place — keeping their ids, so generated sessions stay linked — and missing ones are added. Nothing is
 * ever deleted, and each section keeps its own assigned teachers (explicit teacher overrides aren't copied).
 */
export async function copyConfigsToSections(
  institutionId: string, year: AcademicYear, sourceDivisionId: string, body: z.infer<typeof copyConfigsSchema>
) {
  assertWritable(year);
  const db = academicDb();
  const source = await assertDivision(institutionId, sourceDivisionId);
  const sourceConfigs = await db.timetableSubjectConfig.findMany({ where: { institutionId, academicYearId: year.id, divisionId: sourceDivisionId } });
  if (!sourceConfigs.length) throw httpError(400, "This section has no requirements to copy yet. Save its requirements first.");

  const targets = await db.division.findMany({
    where: {
      institutionId, standardId: source.standardId, id: { not: sourceDivisionId },
      ...(body.targetDivisionIds?.length ? { id: { in: body.targetDivisionIds.filter((x) => x !== sourceDivisionId) } } : {}),
    },
    select: { id: true, name: true, standard: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  if (!targets.length) throw httpError(404, "There are no other sections in this class to copy to.");
  if (body.targetDivisionIds?.length && targets.length !== new Set(body.targetDivisionIds.filter((x) => x !== sourceDivisionId)).size) {
    throw httpError(400, "A target section does not belong to this class.");
  }

  const keyOf = (c: { subjectId: string | null; sessionTypeId: string; title: string | null }) => `${c.subjectId ?? ""}|${c.sessionTypeId}|${(c.title ?? "").trim().toLowerCase()}`;
  const results: { divisionId: string; divisionName: string; added: number; updated: number }[] = [];

  for (const t of targets) {
    await getOrCreateTimetable(institutionId, year, t.id);
    const existing = await db.timetableSubjectConfig.findMany({ where: { institutionId, academicYearId: year.id, divisionId: t.id } });
    const byKey = new Map(existing.map((e) => [keyOf(e), e]));
    let added = 0;
    let updated = 0;
    await db.$transaction(async (tx) => {
      for (const c of sourceConfigs) {
        const match = byKey.get(keyOf(c));
        const data = { periodsPerWeek: c.periodsPerWeek, span: c.span, maxPerDay: c.maxPerDay, roomId: c.roomId, roomType: c.roomType };
        if (match) { await tx.timetableSubjectConfig.update({ where: { id: match.id }, data }); updated++; }
        else {
          await tx.timetableSubjectConfig.create({
            data: { id: randomUUID(), institutionId, academicYearId: year.id, divisionId: t.id, subjectId: c.subjectId, sessionTypeId: c.sessionTypeId, title: c.title, teacherId: null, ...data },
          });
          added++;
        }
      }
    });
    results.push({ divisionId: t.id, divisionName: `${t.standard.name}-${t.name}`, added, updated });
  }
  return results;
}
