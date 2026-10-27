import { z } from "zod";
import type { AcademicYear } from "../../generated/prisma/client";
import { academicDb } from "../../utils/academicContext";
import { assertWritable, httpError, loadYearContext } from "./timetable.common";
import { clearDivision, restoreEntries } from "./timetable.entries.service";
import { setStatus } from "./timetable.generate.service";
import type { Actor } from "./timetable.notify";

// AI Timetable history: the chat with the assistant and saved versions of the
// whole school's timetable (one per build, AI change or restore), so the admin
// can come back to the conversation and go back to an earlier timetable.

const MAX_MESSAGES = 300;
const MAX_VERSIONS = 30;

// Narrow view of the two tables used here (TimetableAiMessage, TimetableVersion).
type Row = Record<string, unknown>;
interface Delegate {
  findMany(args: Row): Promise<Row[]>;
  findFirst(args: Row): Promise<Row | null>;
  create(args: Row): Promise<Row>;
  update(args: Row): Promise<Row>;
  deleteMany(args: Row): Promise<{ count: number }>;
  count(args: Row): Promise<number>;
}
const store = () => academicDb() as unknown as { timetableAiMessage: Delegate; timetableVersion: Delegate };

// ── Chat ──────────────────────────────────────────────────────────────────────
export async function listMessages(institutionId: string, year: AcademicYear) {
  const rows = await store().timetableAiMessage.findMany({
    where: { institutionId, academicYearId: year.id },
    orderBy: { createdAt: "desc" },
    take: MAX_MESSAGES,
  });
  return rows.reverse().map((r) => ({ id: r.id, role: r.role, text: r.text, data: r.data ?? null, createdAt: r.createdAt }));
}

export const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().trim().min(1).max(4000),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

export async function addMessage(institutionId: string, year: AcademicYear, body: z.infer<typeof messageSchema>, userId: string) {
  const m = store().timetableAiMessage;
  const row = await m.create({ data: { institutionId, academicYearId: year.id, role: body.role, text: body.text, data: body.data ?? undefined, createdById: userId } });
  // Keep the chat to a sensible size.
  const total = await m.count({ where: { institutionId, academicYearId: year.id } });
  if (total > MAX_MESSAGES) {
    const old = await m.findMany({ where: { institutionId, academicYearId: year.id }, orderBy: { createdAt: "asc" }, take: total - MAX_MESSAGES, select: { id: true } });
    await m.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }
  return { id: row.id };
}

export const messagePatchSchema = z.object({ data: z.record(z.string(), z.unknown()) }).strict();

/** Merges `data` into a message (e.g. its Apply/Undo state). */
export async function updateMessage(institutionId: string, year: AcademicYear, id: string, body: z.infer<typeof messagePatchSchema>) {
  const m = store().timetableAiMessage;
  const row = await m.findFirst({ where: { id, institutionId, academicYearId: year.id } });
  if (!row) throw httpError(404, "Message not found");
  const data = { ...((row.data as Row | null) ?? {}), ...body.data };
  await m.update({ where: { id }, data: { data } });
  return { id };
}

export async function clearMessages(institutionId: string, year: AcademicYear) {
  const out = await store().timetableAiMessage.deleteMany({ where: { institutionId, academicYearId: year.id } });
  return { removed: out.count };
}

// ── Versions ──────────────────────────────────────────────────────────────────
interface SnapEntry {
  divisionId: string; dayOfWeek: number; slotId: string; sessionTypeId: string; subjectId: string | null; title: string | null;
  teacherId: string | null; roomId: string | null; configId: string | null; groupId: string | null; isLocked: boolean;
}

export async function listVersions(institutionId: string, year: AcademicYear) {
  const rows = await store().timetableVersion.findMany({
    where: { institutionId, academicYearId: year.id },
    orderBy: { number: "desc" },
    select: { id: true, number: true, label: true, periods: true, createdAt: true },
  });
  return rows;
}

export async function getVersion(institutionId: string, year: AcademicYear, id: string) {
  const row = await store().timetableVersion.findFirst({ where: { id, institutionId, academicYearId: year.id } });
  if (!row) throw httpError(404, "Version not found");
  return { id: row.id, number: row.number, label: row.label, createdAt: row.createdAt, entries: row.entries as SnapEntry[] };
}

export const versionSchema = z.object({ label: z.string().trim().min(1).max(80) }).strict();

/** Saves the timetable as it is right now. Skips it when nothing changed since the last version. */
export async function saveVersion(institutionId: string, year: AcademicYear, label: string, userId: string | null) {
  const rows = await academicDb().timetableEntry.findMany({
    where: { institutionId, academicYearId: year.id },
    select: { divisionId: true, dayOfWeek: true, slotId: true, sessionTypeId: true, subjectId: true, title: true, teacherId: true, roomId: true, configId: true, groupId: true, isLocked: true },
    orderBy: [{ divisionId: "asc" }, { dayOfWeek: "asc" }, { slotId: "asc" }],
  });
  const v = store().timetableVersion;
  const last = await v.findFirst({ where: { institutionId, academicYearId: year.id }, orderBy: { number: "desc" } });
  const sig = (list: SnapEntry[]) => list.map((e) => `${e.divisionId}|${e.dayOfWeek}|${e.slotId}|${e.subjectId}|${e.title}|${e.teacherId}|${e.roomId}`).sort().join(";");
  if (last && sig(last.entries as SnapEntry[]) === sig(rows)) return { id: last.id, number: last.number, created: false };
  const number = ((last?.number as number | undefined) ?? 0) + 1;
  const row = await v.create({ data: { institutionId, academicYearId: year.id, number, label, entries: rows, periods: rows.length, createdById: userId } });
  const total = await v.count({ where: { institutionId, academicYearId: year.id } });
  if (total > MAX_VERSIONS) {
    const old = await v.findMany({ where: { institutionId, academicYearId: year.id }, orderBy: { number: "asc" }, take: total - MAX_VERSIONS, select: { id: true } });
    await v.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }
  return { id: row.id, number, created: true };
}

/**
 * Puts an earlier version back for every section: published sections go back to draft,
 * each section is cleared and refilled. Periods that no longer fit (a deleted period,
 * teacher or subject) are left out and counted.
 */
export async function restoreVersion(institutionId: string, year: AcademicYear, id: string, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const version = await getVersion(institutionId, year, id);
  const ctx = await loadYearContext(institutionId, year);
  const slotIds = new Set(ctx.slots.map((s) => s.id));
  const teacherIds = new Set(ctx.teachers.map((t) => t.id));
  const [subjects, configs, divisions] = await Promise.all([
    db.subject.findMany({ where: { institutionId }, select: { id: true } }),
    db.timetableSubjectConfig.findMany({ where: { institutionId, academicYearId: year.id }, select: { id: true } }),
    db.division.findMany({ where: { institutionId }, select: { id: true } }),
  ]);
  const subjectIds = new Set(subjects.map((s) => s.id));
  const configIds = new Set(configs.map((c) => c.id));
  const divisionIds = new Set(divisions.map((d) => d.id));

  // Every section that has periods now or in the version.
  const now = await db.timetableEntry.findMany({ where: { institutionId, academicYearId: year.id }, select: { divisionId: true }, distinct: ["divisionId"] });
  const touched = new Set([...now.map((e) => e.divisionId), ...version.entries.map((e) => e.divisionId)].filter((d) => divisionIds.has(d)));
  const published = await db.schoolTimetable.findMany({ where: { institutionId, academicYearId: year.id, status: "PUBLISHED", divisionId: { in: [...touched] } }, select: { divisionId: true } });
  for (const p of published) await setStatus(institutionId, year, p.divisionId, { status: "DRAFT", force: true }, actor);

  let skipped = 0;
  for (const divisionId of touched) {
    await clearDivision(institutionId, year, divisionId, false, actor);
    const entries = version.entries.filter((e) => e.divisionId === divisionId).flatMap((e) => {
      if (!slotIds.has(e.slotId) || !ctx.sessionTypes.has(e.sessionTypeId) || (e.subjectId && !subjectIds.has(e.subjectId))) { skipped++; return []; }
      return [{
        dayOfWeek: e.dayOfWeek, slotId: e.slotId, sessionTypeId: e.sessionTypeId, subjectId: e.subjectId, title: e.title,
        teacherId: e.teacherId && teacherIds.has(e.teacherId) ? e.teacherId : null,
        roomId: e.roomId && ctx.rooms.has(e.roomId) ? e.roomId : null,
        configId: e.configId && configIds.has(e.configId) ? e.configId : null,
        groupKey: e.groupId, isLocked: e.isLocked,
      }];
    });
    for (let i = 0; i < entries.length; i += 400) await restoreEntries(institutionId, year, divisionId, { entries: entries.slice(i, i + 400) }, actor);
  }
  const saved = await saveVersion(institutionId, year, `Back to version ${version.number}`, actor.userId);
  return { restored: version.number, skipped, unpublished: published.length, version: saved.number };
}
