import { randomUUID } from "crypto";
import { z } from "zod";
import type { AcademicYear, TimetableStatus } from "../../generated/prisma/client";
import { Prisma } from "../../generated/prisma/client";
import { academicDb } from "../../utils/academicContext";
import { TimetableConflictError, assertWritable, httpError, loadYearContext, loadYearEntries } from "./timetable.common";
import { generateTimetable, type EngineConfig } from "./timetable.engine";
import { assertDivision, getOrCreateTimetable, loadEngineConfigs, yearConflicts } from "./timetable.studio.service";
import { audit, divisionStudentUserIds, notifyUsers, teacherUserIds, type Actor } from "./timetable.notify";
import { bulkStatusSchema, generateBulkSchema, statusSchema } from "./timetable.schema";

export interface DivisionGenerationResult {
  divisionId: string;
  divisionName: string;
  complete: boolean;
  placed: number;
  unplaced: number;
  problems: string[];
  timedOut: boolean;
}

export async function generateForDivision(
  institutionId: string, year: AcademicYear, divisionId: string, keepLocked: boolean, actor: Actor, variation?: number
): Promise<DivisionGenerationResult> {
  assertWritable(year);
  const db = academicDb();
  await assertDivision(institutionId, divisionId);
  const timetable = await getOrCreateTimetable(institutionId, year, divisionId);
  if (timetable.status === "PUBLISHED") throw httpError(409, "This timetable is published. Unpublish it before regenerating.");
  if (timetable.status === "ARCHIVED") throw httpError(409, "This timetable is archived. Move it back to draft first.");

  const ctx = await loadYearContext(institutionId, year);
  const divisionName = ctx.labels.division(divisionId);
  const fail = (problem: string): DivisionGenerationResult => ({ divisionId, divisionName, complete: false, placed: 0, unplaced: 0, problems: [problem], timedOut: false });
  if (!ctx.workingDays.length) return fail("No working days are configured. Set them in Timetable → Setup.");
  if (!ctx.slots.some((s) => s.kind === "PERIOD")) return fail("No teaching periods are configured. Add periods in Timetable → Setup.");

  const allConfigs = await loadEngineConfigs(institutionId, year.id, [divisionId]);
  const configs: EngineConfig[] = allConfigs.filter((c) => ctx.sessionTypes.get(c.sessionTypeId)?.isActive !== false);
  if (!configs.length) return fail("No weekly subject requirements are set for this class yet. Open the class timetable, click the Edit requirements button and add how many periods each subject needs per week.");

  const entries = await loadYearEntries(institutionId, year.id);
  const mine = entries.filter((e) => e.divisionId === divisionId);
  const locked = keepLocked ? mine.filter((e) => e.isLocked) : [];
  const other = entries.filter((e) => e.divisionId !== divisionId);

  const result = generateTimetable({
    divisionId, slots: ctx.slots, workingDays: ctx.workingDays, configs, sessionTypes: ctx.sessionTypes,
    rooms: [...ctx.rooms.values()], lockedEntries: locked, otherEntries: other,
    teacherUnavailable: ctx.teacherUnavailable, teacherPreferred: ctx.teacherPreferred, roomUnavailable: ctx.roomUnavailable,
    teacherPrefs: ctx.teacherPrefs, labels: ctx.labels, seed: variation,
  });

  const configById = new Map(configs.map((c) => [c.id, c]));
  const raw = await db.timetableSubjectConfig.findMany({ where: { institutionId, academicYearId: year.id, divisionId }, select: { id: true, title: true } });
  const titleById = new Map(raw.map((r) => [r.id, r.title]));

  const rows: Prisma.TimetableEntryCreateManyInput[] = [];
  for (const p of result.placements) {
    const c = configById.get(p.configId)!;
    const groupId = p.slotIds.length > 1 ? randomUUID() : null;
    for (const slotId of p.slotIds) {
      rows.push({
        institutionId, academicYearId: year.id, timetableId: timetable.id, divisionId, dayOfWeek: p.dayOfWeek, slotId,
        sessionTypeId: c.sessionTypeId, subjectId: c.subjectId, title: titleById.get(c.id) ?? null,
        teacherId: p.teacherId, roomId: p.roomId, configId: c.id, groupId,
      });
    }
  }

  const hadEntries = mine.length > 0;
  await db.$transaction(async (tx) => {
    await tx.timetableEntry.deleteMany({ where: { timetableId: timetable.id, ...(keepLocked ? { isLocked: false } : {}) } });
    if (rows.length) await tx.timetableEntry.createMany({ data: rows });
    await tx.schoolTimetable.update({ where: { id: timetable.id }, data: { status: "GENERATED", generatedAt: new Date() } });
    await tx.timetableGeneration.create({
      data: {
        institutionId, academicYearId: year.id, timetableId: timetable.id, complete: result.complete,
        placed: result.placed, unplaced: result.unplaced, problems: result.problems as unknown as Prisma.InputJsonValue, createdById: actor.userId,
      },
    });
  });
  audit(actor, hadEntries ? "TIMETABLE_REGENERATED" : "TIMETABLE_GENERATED", `${hadEntries ? "Regenerated" : "Generated"} timetable for ${divisionName} (${result.complete ? "complete" : `${result.unplaced} periods unplaced`})`, {
    divisionId, academicYearId: year.id, placed: result.placed, unplaced: result.unplaced, keptLocked: locked.length,
  });
  return { divisionId, divisionName, complete: result.complete, placed: result.placed, unplaced: result.unplaced, problems: result.problems, timedOut: result.timedOut };
}

export async function generateBulk(institutionId: string, year: AcademicYear, body: z.infer<typeof generateBulkSchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const divisions = await db.division.findMany({
    where: {
      institutionId,
      ...(body.divisionIds?.length ? { id: { in: body.divisionIds } } : {}),
      ...(body.standardId ? { standardId: body.standardId } : {}),
    },
    select: { id: true, standard: { select: { order: true } }, name: true },
    orderBy: [{ standard: { order: "asc" } }, { name: "asc" }],
  });
  if (!divisions.length) throw httpError(404, "No classes found to generate");
  const results: DivisionGenerationResult[] = [];
  // Sequential: each class sees the teacher/room occupancy created by the ones before it.
  for (const d of divisions) {
    try {
      results.push(await generateForDivision(institutionId, year, d.id, body.keepLocked, actor, body.variation));
    } catch (e) {
      const msg = (e as { message?: string }).message ?? "Failed";
      results.push({ divisionId: d.id, divisionName: d.name, complete: false, placed: 0, unplaced: 0, problems: [msg], timedOut: false });
    }
  }
  return results;
}

// ── lifecycle ──────────────────────────────────────────────────────────────────
const TRANSITIONS: Record<TimetableStatus, TimetableStatus[]> = {
  DRAFT: ["GENERATED", "UNDER_REVIEW", "PUBLISHED", "ARCHIVED"],
  GENERATED: ["DRAFT", "UNDER_REVIEW", "PUBLISHED", "ARCHIVED"],
  UNDER_REVIEW: ["DRAFT", "GENERATED", "PUBLISHED", "ARCHIVED"],
  PUBLISHED: ["DRAFT", "ARCHIVED"],
  ARCHIVED: ["DRAFT"],
};

export async function setStatus(
  institutionId: string, year: AcademicYear, divisionId: string, body: z.infer<typeof statusSchema>, actor: Actor
) {
  assertWritable(year);
  const db = academicDb();
  await assertDivision(institutionId, divisionId);
  const tt = await getOrCreateTimetable(institutionId, year, divisionId);
  if (tt.status === body.status) return { status: tt.status, publishedAt: tt.publishedAt, conflicts: [] };
  if (!TRANSITIONS[tt.status].includes(body.status)) {
    throw httpError(409, `A ${tt.status.toLowerCase().replace("_", " ")} timetable cannot move to ${body.status.toLowerCase().replace("_", " ")}.`);
  }

  let conflicts: ReturnType<typeof yearConflicts> = [];
  if (body.status === "PUBLISHED") {
    const count = await db.timetableEntry.count({ where: { timetableId: tt.id } });
    if (count === 0) throw httpError(409, "Cannot publish an empty timetable.");
    const ctx = await loadYearContext(institutionId, year);
    const all = await loadYearEntries(institutionId, year.id);
    conflicts = yearConflicts(ctx, all).filter(
      (c) => c.severity === "ERROR" && (c.divisionId === divisionId || c.cells.some((x) => x.divisionId === divisionId))
    );
    if (conflicts.length && !body.force) {
      throw new TimetableConflictError(`${conflicts.length} unresolved conflict${conflicts.length === 1 ? "" : "s"} — resolve them or publish anyway.`, conflicts);
    }
  }

  const updated = await db.schoolTimetable.update({
    where: { id: tt.id },
    data: { status: body.status, ...(body.status === "PUBLISHED" ? { publishedAt: new Date() } : {}) },
  });
  const verb = body.status === "PUBLISHED" ? "PUBLISHED" : tt.status === "PUBLISHED" ? "UNPUBLISHED" : body.status === "ARCHIVED" ? "ARCHIVED" : "STATUS_CHANGED";
  const ctx = await loadYearContext(institutionId, year);
  audit(actor, `TIMETABLE_${verb}`, `Timetable of ${ctx.labels.division(divisionId)} ${tt.status} → ${body.status}`, {
    divisionId, academicYearId: year.id, from: tt.status, to: body.status, forced: !!body.force && conflicts.length > 0,
  });

  if (body.status === "PUBLISHED") {
    const entries = await db.timetableEntry.findMany({ where: { timetableId: tt.id, teacherId: { not: null } }, select: { teacherId: true } });
    const [teachers, students] = await Promise.all([
      teacherUserIds(institutionId, entries.map((e) => e.teacherId!)),
      divisionStudentUserIds(institutionId, divisionId, year.id),
    ]);
    const div = ctx.labels.division(divisionId);
    notifyUsers({ institutionId, userIds: teachers, title: "Timetable published", message: `The timetable for ${div} (${year.label}) is now live. Check My Timetable.`, tag: "TIMETABLE_PUBLISHED", sentById: actor.userId });
    notifyUsers({ institutionId, userIds: students, title: "Timetable published", message: `Your class timetable for ${year.label} is now available.`, tag: "TIMETABLE_PUBLISHED", sentById: actor.userId });
  }
  return { status: updated.status, publishedAt: updated.publishedAt, conflicts };
}

export async function setStatusBulk(institutionId: string, year: AcademicYear, body: z.infer<typeof bulkStatusSchema>, actor: Actor) {
  const out: { divisionId: string; ok: boolean; error?: string }[] = [];
  for (const divisionId of body.divisionIds) {
    try {
      await setStatus(institutionId, year, divisionId, { status: body.status, force: body.force }, actor);
      out.push({ divisionId, ok: true });
    } catch (e) {
      out.push({ divisionId, ok: false, error: (e as { message?: string }).message ?? "Failed" });
    }
  }
  return out;
}

export async function listTimetableStatuses(institutionId: string, year: AcademicYear) {
  const db = academicDb();
  const [divisions, timetables, counts] = await Promise.all([
    db.division.findMany({
      where: { institutionId },
      select: { id: true, name: true, standard: { select: { id: true, name: true, order: true } } },
      orderBy: [{ standard: { order: "asc" } }, { name: "asc" }],
    }),
    db.schoolTimetable.findMany({ where: { institutionId, academicYearId: year.id }, select: { divisionId: true, status: true, publishedAt: true, generatedAt: true } }),
    db.timetableEntry.groupBy({ by: ["divisionId"], where: { institutionId, academicYearId: year.id }, _count: { _all: true } }),
  ]);
  const ttBy = new Map(timetables.map((t) => [t.divisionId, t]));
  const cntBy = new Map(counts.map((c) => [c.divisionId, c._count._all]));
  return divisions.map((d) => ({
    divisionId: d.id, divisionName: d.name, standardId: d.standard.id, standardName: d.standard.name,
    status: ttBy.get(d.id)?.status ?? null, publishedAt: ttBy.get(d.id)?.publishedAt ?? null,
    generatedAt: ttBy.get(d.id)?.generatedAt ?? null, entryCount: cntBy.get(d.id) ?? 0,
  }));
}
