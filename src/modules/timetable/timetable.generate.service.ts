import { randomUUID } from "crypto";
import { z } from "zod";
import type { AcademicYear, TimetableStatus } from "../../generated/prisma/client";
import { Prisma } from "../../generated/prisma/client";
import { academicDb } from "../../utils/academicContext";
import { TimetableConflictError, assertWritable, classLabel, httpError, loadYearContext, loadYearEntries } from "./timetable.common";
import { generateTimetable, type EngineConfig, type EngineEntry, type GeneratorResult } from "./timetable.engine";
import { assertDivision, getOrCreateTimetable, loadEngineConfigs, yearConflicts } from "./timetable.studio.service";
import { audit, divisionStudentUserIds, notifyUsers, teacherUserIds, type Actor } from "./timetable.notify";
import { bulkStatusSchema, generateBulkSchema, generatePublishSchema, statusSchema } from "./timetable.schema";

/** A session of ANOTHER section that was moved so this section could be filled. */
export interface RearrangedItem {
  divisionId: string;
  divisionName: string;
  subject: string;
  from: string;
  to: string;
}

export interface DivisionGenerationResult {
  divisionId: string;
  divisionName: string;
  complete: boolean;
  placed: number;
  unplaced: number;
  problems: string[];
  timedOut: boolean;
  rearranged: RearrangedItem[];
}

const sigOf = (c: { type: string; entryIds: string[]; message: string }) => `${c.type}:${[...c.entryIds].sort().join(",")}:${c.message}`;

export async function generateForDivision(
  institutionId: string, year: AcademicYear, divisionId: string, keepLocked: boolean, actor: Actor, variation?: number,
  opts: { rearrange?: boolean } = {}
): Promise<DivisionGenerationResult> {
  assertWritable(year);
  const db = academicDb();
  await assertDivision(institutionId, divisionId);
  const timetable = await getOrCreateTimetable(institutionId, year, divisionId);
  if (timetable.status === "PUBLISHED") throw httpError(409, "This timetable is published. Unpublish it before regenerating.");
  if (timetable.status === "ARCHIVED") throw httpError(409, "This timetable is archived. Move it back to draft first.");

  const ctx = await loadYearContext(institutionId, year);
  const divisionName = ctx.labels.division(divisionId);
  const fail = (problem: string): DivisionGenerationResult => ({ divisionId, divisionName, complete: false, placed: 0, unplaced: 0, problems: [problem], timedOut: false, rearranged: [] });
  if (!ctx.workingDays.length) return fail("No working days are configured. Set them in Timetable → Setup.");
  if (!ctx.slots.some((s) => s.kind === "PERIOD")) return fail("No teaching periods are configured. Add periods in Timetable → Setup.");

  const allConfigs = await loadEngineConfigs(institutionId, year.id, [divisionId]);
  const configs: EngineConfig[] = allConfigs.filter((c) => ctx.sessionTypes.get(c.sessionTypeId)?.isActive !== false);
  if (!configs.length) return fail("No weekly subject requirements are set for this class yet. Open the class timetable, click the Edit requirements button and add how many periods each subject needs per week.");

  const entries = await loadYearEntries(institutionId, year.id);
  const mine = entries.filter((e) => e.divisionId === divisionId);
  const locked = keepLocked ? mine.filter((e) => e.isLocked) : [];
  const other = entries.filter((e) => e.divisionId !== divisionId);

  // Other sections whose UNLOCKED sessions may be moved to make room: only ones that aren't live yet.
  const otherTimetables = opts.rearrange === false ? [] : await db.schoolTimetable.findMany({
    where: { institutionId, academicYearId: year.id, divisionId: { not: divisionId }, status: { in: ["DRAFT", "GENERATED", "UNDER_REVIEW"] } },
    select: { divisionId: true },
  });
  const movableIds = otherTimetables.map((t) => t.divisionId);
  const movableConfigs = movableIds.length ? await loadEngineConfigs(institutionId, year.id, movableIds) : [];

  const runEngine = (withMovable: boolean) => generateTimetable({
    divisionId, slots: ctx.slots, workingDays: ctx.workingDays, configs, sessionTypes: ctx.sessionTypes,
    rooms: [...ctx.rooms.values()], lockedEntries: locked, otherEntries: other,
    teacherUnavailable: ctx.teacherUnavailable, teacherPreferred: ctx.teacherPreferred, roomUnavailable: ctx.roomUnavailable,
    teacherPrefs: ctx.teacherPrefs, labels: ctx.labels, seed: variation,
    movable: withMovable && movableIds.length ? { divisionIds: new Set(movableIds), configs: movableConfigs } : undefined,
  });
  let result: GeneratorResult = runEngine(true);

  // Safety net: the engine only makes moves that satisfy every hard rule, but verify the final picture across
  // ALL sections anyway. If anything would be in conflict, discard the rearranging and use the plain result.
  const toPlaceRows = (res: GeneratorResult) => res.placements.flatMap((p) => {
    const c = allConfigs.find((x) => x.id === p.configId)!;
    const groupId = p.slotIds.length > 1 ? randomUUID() : null;
    return p.slotIds.map((slotId) => ({ cfg: c, p, slotId, groupId }));
  });
  if (result.moves.length) {
    const movedAt = new Map(result.moves.flatMap((m) => m.entryIds.map((id, i) => [id, { m, i }] as const)));
    const after: EngineEntry[] = entries
      .filter((e) => !(e.divisionId === divisionId && (!keepLocked || !e.isLocked)))
      .map((e) => {
        const mv = movedAt.get(e.id);
        return mv ? { ...e, dayOfWeek: mv.m.toDay, slotId: mv.m.toSlotIds[mv.i], roomId: mv.m.toRoomId } : e;
      });
    for (const r of toPlaceRows(result)) {
      after.push({
        id: randomUUID(), divisionId, dayOfWeek: r.p.dayOfWeek, slotId: r.slotId, sessionTypeId: r.cfg.sessionTypeId, subjectId: r.cfg.subjectId,
        teacherId: r.p.teacherId, roomId: r.p.roomId, configId: r.cfg.id, groupId: r.groupId, isLocked: false,
      });
    }
    const before = new Set(yearConflicts(ctx, entries).filter((c) => c.severity === "ERROR").map(sigOf));
    const introduced = yearConflicts(ctx, after).filter((c) => c.severity === "ERROR" && !before.has(sigOf(c)));
    if (introduced.length) {
      console.error("Timetable make-room produced conflicts; falling back to the plain result:", introduced.map((c) => c.message));
      result = runEngine(false);
    }
  }

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
    // Sessions of other (unpublished) sections that were moved to make room. Park them on unique temporary days
    // first so two sessions swapping places can't collide on the (section, day, period) unique index.
    const moveRows = result.moves.flatMap((m) => m.entryIds.map((id, i) => ({ id, dayOfWeek: m.toDay, slotId: m.toSlotIds[i], roomId: m.toRoomId })));
    for (const [i, m] of moveRows.entries()) await tx.timetableEntry.update({ where: { id: m.id }, data: { dayOfWeek: -(i + 1) } });
    for (const m of moveRows) await tx.timetableEntry.update({ where: { id: m.id }, data: { dayOfWeek: m.dayOfWeek, slotId: m.slotId, roomId: m.roomId } });
    if (rows.length) await tx.timetableEntry.createMany({ data: rows });
    await tx.schoolTimetable.update({ where: { id: timetable.id }, data: { status: "GENERATED", generatedAt: new Date() } });
    await tx.timetableGeneration.create({
      data: {
        institutionId, academicYearId: year.id, timetableId: timetable.id, complete: result.complete,
        placed: result.placed, unplaced: result.unplaced, problems: result.problems as unknown as Prisma.InputJsonValue, createdById: actor.userId,
      },
    });
  });
  const slotName = (id: string) => ctx.labels.slot(id);
  const when = (day: number, slotIds: string[]) => `${ctx.labels.day(day).slice(0, 3)} ${slotIds.length > 1 ? `${slotName(slotIds[0])}–${slotName(slotIds[slotIds.length - 1])}` : slotName(slotIds[0])}`;
  const rearranged: RearrangedItem[] = result.moves.map((m) => ({
    divisionId: m.divisionId,
    divisionName: ctx.labels.division(m.divisionId),
    subject: movableConfigs.find((c) => c.id === m.configId)?.label ?? "Session",
    from: when(m.fromDay, m.fromSlotIds),
    to: when(m.toDay, m.toSlotIds),
  }));
  if (rearranged.length) {
    audit(actor, "TIMETABLE_SESSIONS_REARRANGED", `Generating ${divisionName} moved ${rearranged.length} session(s) in other unpublished sections to make room`, {
      divisionId, academicYearId: year.id, moved: rearranged.length, sections: [...new Set(rearranged.map((r) => r.divisionName))],
    });
  }
  audit(actor, hadEntries ? "TIMETABLE_REGENERATED" : "TIMETABLE_GENERATED", `${hadEntries ? "Regenerated" : "Generated"} timetable for ${divisionName} (${result.complete ? "complete" : `${result.unplaced} periods unplaced`})`, {
    divisionId, academicYearId: year.id, placed: result.placed, unplaced: result.unplaced, keptLocked: locked.length,
  });
  return { divisionId, divisionName, complete: result.complete, placed: result.placed, unplaced: result.unplaced, problems: result.problems, timedOut: result.timedOut, rearranged };
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
      results.push({ divisionId: d.id, divisionName: d.name, complete: false, placed: 0, unplaced: 0, problems: [msg], timedOut: false, rearranged: [] });
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

export type GeneratePublishOutcome = "PUBLISHED" | "NEEDS_ATTENTION" | "SKIPPED";
export interface GeneratePublishResult {
  divisionId: string;
  divisionName: string;
  outcome: GeneratePublishOutcome;
  reasons: string[];
  placed: number;
  unplaced: number;
  /** Sessions of other, still-unpublished sections that were moved while generating this one. */
  rearranged: RearrangedItem[];
}

/**
 * One click for a whole class (or school): generate every section — each one may move other, still unpublished
 * sections' unlocked sessions to make room — and only THEN publish the ones that came out complete and
 * conflict-free. Publishing last matters: a published section is frozen, so publishing early would stop later
 * sections from rearranging it. Anything with problems stays a draft with the reasons; nothing is forced live.
 */
export async function generateAndPublish(institutionId: string, year: AcademicYear, body: z.infer<typeof generatePublishSchema>, actor: Actor): Promise<GeneratePublishResult[]> {
  assertWritable(year);
  const db = academicDb();
  const divisions = await db.division.findMany({
    where: {
      institutionId,
      ...(body.divisionIds?.length ? { id: { in: body.divisionIds } } : {}),
      ...(body.standardId ? { standardId: body.standardId } : {}),
    },
    select: { id: true, name: true, standard: { select: { name: true, order: true } } },
    orderBy: [{ standard: { order: "asc" } }, { name: "asc" }],
  });
  if (!divisions.length) throw httpError(404, "No classes found");

  const byId = new Map<string, GeneratePublishResult>();
  const order: string[] = [];
  const record = (id: string, name: string, outcome: GeneratePublishOutcome, reasons: string[], placed = 0, unplaced = 0, rearranged: RearrangedItem[] = []) => {
    if (!byId.has(id)) order.push(id);
    byId.set(id, { divisionId: id, divisionName: name, outcome, reasons, placed, unplaced, rearranged });
  };
  const ready: { id: string; name: string }[] = [];

  // Phase 1 — generate, one section after another so each sees what the earlier ones used.
  for (const d of divisions) {
    const name = classLabel(d.standard.name, d.name);
    try {
      const tt = await db.schoolTimetable.findUnique({ where: { divisionId_academicYearId: { divisionId: d.id, academicYearId: year.id } } });
      if (tt?.status === "PUBLISHED") { record(d.id, name, "SKIPPED", ["Already published. Unpublish it first to regenerate."]); continue; }
      if (tt?.status === "ARCHIVED") { record(d.id, name, "SKIPPED", ["Archived. Move it back to draft first."]); continue; }
      const gen = await generateForDivision(institutionId, year, d.id, body.keepLocked, actor, body.variation);
      if (!gen.complete) {
        const noConfigs = gen.placed === 0 && gen.unplaced === 0;
        record(d.id, name, noConfigs ? "SKIPPED" : "NEEDS_ATTENTION", gen.problems, gen.placed, gen.unplaced, gen.rearranged);
        continue;
      }
      record(d.id, name, "NEEDS_ATTENTION", [], gen.placed, 0, gen.rearranged);   // provisional until published below
      ready.push({ id: d.id, name });
    } catch (e) {
      record(d.id, name, "SKIPPED", [(e as { message?: string }).message ?? "Failed"]);
    }
  }

  // Phase 2 — publish the ones that are complete and clean.
  for (const r of ready) {
    const prev = byId.get(r.id)!;
    try {
      await setStatus(institutionId, year, r.id, { status: "PUBLISHED" }, actor);
      record(r.id, r.name, "PUBLISHED", [], prev.placed, 0, prev.rearranged);
    } catch (e) {
      if (e instanceof TimetableConflictError) record(r.id, r.name, "NEEDS_ATTENTION", ["Generated, but not published because of conflicts:", ...e.conflicts.slice(0, 5).map((c) => c.message)], prev.placed, 0, prev.rearranged);
      else record(r.id, r.name, "NEEDS_ATTENTION", [(e as { message?: string }).message ?? "Could not publish"], prev.placed, 0, prev.rearranged);
    }
  }

  const results = order.map((id) => byId.get(id)!);
  audit(actor, "TIMETABLE_GENERATE_PUBLISH_ALL", `Generate & publish: ${results.filter((r) => r.outcome === "PUBLISHED").length}/${results.length} published`, {
    academicYearId: year.id, published: results.filter((r) => r.outcome === "PUBLISHED").length, total: results.length,
  });
  return results;
}
