import { randomUUID } from "crypto";
import { z } from "zod";
import type { AcademicYear } from "../../generated/prisma/client";
import { academicDb } from "../../utils/academicContext";
import { recordAiUsage } from "../../services/ai-usage.service";
import { assertWritable, classLabel, ensureSessionTypes, httpError, loadYearContext, loadYearEntries, TimetableConflictError } from "./timetable.common";
import { loadEngineConfigs, saveConfigs, yearConflicts } from "./timetable.studio.service";
import { moveEntry, restoreEntries, swapEntries } from "./timetable.entries.service";
import { setStatus } from "./timetable.generate.service";
import type { Actor } from "./timetable.notify";
import { configItemSchema } from "./timetable.schema";

// AI Timetable: one page where the admin builds the whole school's timetable
// for the year. The engine (timetable.engine.ts) places every period, so there
// are never clashes; the AI only turns the admin's words into the engine's
// rules (periods per week, teacher free time, limits, moves) and answers questions.

const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ── Everything the page needs, in one call ───────────────────────────────────
export async function workspace(institutionId: string, year: AcademicYear) {
  const db = academicDb();
  const ctx = await loadYearContext(institutionId, year);
  const [standards, divisionSubjects, subjects, configs, timetables, entryRows, assignments, availability] = await Promise.all([
    db.standard.findMany({ where: { institutionId }, select: { id: true, name: true, order: true, divisions: { select: { id: true, name: true, classTeacherId: true }, orderBy: { name: "asc" } } }, orderBy: { order: "asc" } }),
    db.divisionSubject.findMany({ where: { institutionId }, select: { divisionId: true, subjectId: true } }),
    db.subject.findMany({ where: { institutionId }, select: { id: true, name: true, standardId: true, color: true, order: true }, orderBy: { order: "asc" } }),
    db.timetableSubjectConfig.findMany({ where: { institutionId, academicYearId: year.id }, select: { id: true, divisionId: true, subjectId: true, sessionTypeId: true, title: true, periodsPerWeek: true, teacherId: true, span: true, roomType: true } }),
    db.schoolTimetable.findMany({ where: { institutionId, academicYearId: year.id }, select: { divisionId: true, status: true, publishedAt: true } }),
    db.timetableEntry.findMany({ where: { institutionId, academicYearId: year.id }, select: { id: true, divisionId: true, dayOfWeek: true, slotId: true, sessionTypeId: true, subjectId: true, title: true, teacherId: true, roomId: true, isLocked: true, configId: true, groupId: true } }),
    db.divisionAssignment.findMany({ where: { institutionId, academicYearId: year.id, subjectId: { not: null } }, select: { divisionId: true, subjectId: true, teacherId: true }, orderBy: { createdAt: "asc" } }),
    db.teacherAvailability.findMany({ where: { institutionId, academicYearId: year.id, kind: "UNAVAILABLE" }, select: { teacherId: true, dayOfWeek: true, slotId: true } }),
  ]);
  const engineConfigs = await loadEngineConfigs(institutionId, year.id, configs.map((c) => c.divisionId));
  const resolvedTeacher = new Map(engineConfigs.map((c) => [c.id, c.teacherId]));
  const conflicts = yearConflicts(ctx, await loadYearEntries(institutionId, year.id)).filter((c) => c.severity === "ERROR");
  const statusOf = new Map(timetables.map((t) => [t.divisionId, t.status]));
  return {
    year: { id: year.id, label: year.label, writable: year.status === "ACTIVE" },
    workingDays: ctx.workingDays,
    slots: ctx.slots,
    sessionTypes: [...ctx.sessionTypes.values()].map((t) => ({ id: t.id, name: t.name, kind: t.kind, color: t.color, requiresTeacher: t.requiresTeacher })),
    rooms: [...ctx.rooms.values()].map((r) => ({ id: r.id, name: r.name, type: r.type, isActive: r.isActive })),
    teachers: ctx.teachers.map((t) => ({ id: t.id, name: t.name })),
    standards: standards.filter((s) => s.divisions.length).map((s) => ({
      id: s.id, name: s.name, order: s.order,
      divisions: s.divisions.map((d) => ({ id: d.id, name: d.name, label: classLabel(s.name, d.name), status: statusOf.get(d.id) ?? "DRAFT", classTeacherId: d.classTeacherId })),
    })),
    subjects,
    divisionSubjects,
    assignments,
    configs: configs.map((c) => ({ ...c, teacherId: c.teacherId ?? resolvedTeacher.get(c.id) ?? null, ownTeacher: !!c.teacherId })),
    entries: entryRows,
    unavailable: availability,
    teacherPrefs: [...ctx.teacherPrefs.entries()].map(([teacherId, p]) => ({ teacherId, ...p })),
    conflicts: conflicts.slice(0, 50).map((c) => ({ type: c.type, message: c.message })),
    conflictCount: conflicts.length,
  };
}

export async function entriesOnly(institutionId: string, year: AcademicYear) {
  const db = academicDb();
  const [entries, timetables] = await Promise.all([
    db.timetableEntry.findMany({ where: { institutionId, academicYearId: year.id }, select: { id: true, divisionId: true, dayOfWeek: true, slotId: true, sessionTypeId: true, subjectId: true, title: true, teacherId: true, roomId: true, isLocked: true, configId: true, groupId: true } }),
    db.schoolTimetable.findMany({ where: { institutionId, academicYearId: year.id }, select: { divisionId: true, status: true } }),
  ]);
  return { entries, statuses: timetables };
}

// ── School day in one go ──────────────────────────────────────────────────────
export const quickSetupSchema = z.object({
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startMinute: z.number().int().min(5 * 60).max(12 * 60),
  periodMinutes: z.number().int().min(20).max(90),
  periods: z.number().int().min(3).max(12),
  breaks: z.array(z.object({ afterPeriod: z.number().int().min(1).max(11), minutes: z.number().int().min(5).max(90), kind: z.enum(["BREAK", "LUNCH"]) })).max(4).default([]),
  force: z.boolean().optional(),
}).strict();

export async function quickSetup(institutionId: string, year: AcademicYear, body: z.infer<typeof quickSetupSchema>) {
  assertWritable(year);
  const db = academicDb();
  const used = await db.timetableEntry.count({ where: { institutionId, academicYearId: year.id } });
  if (used && !body.force) throw httpError(409, "The timetable already has periods. Changing the school day clears the timetable; confirm to continue.");
  const rows: { name: string; startMinute: number; endMinute: number; kind: "PERIOD" | "BREAK" | "LUNCH" }[] = [];
  let t = body.startMinute;
  for (let p = 1; p <= body.periods; p++) {
    rows.push({ name: `Period ${p}`, startMinute: t, endMinute: t + body.periodMinutes, kind: "PERIOD" });
    t += body.periodMinutes;
    for (const b of body.breaks.filter((x) => x.afterPeriod === p && p < body.periods)) {
      rows.push({ name: b.kind === "LUNCH" ? "Lunch" : "Short break", startMinute: t, endMinute: t + b.minutes, kind: b.kind });
      t += b.minutes;
    }
  }
  if (t > 20 * 60) throw httpError(400, "The school day ends too late. Use fewer or shorter periods.");
  const days = [...new Set(body.workingDays)].sort((a, b) => a - b);
  await db.$transaction(async (tx) => {
    // Slots go with their periods, free-time marks and exceptions (cascade).
    await tx.timeSlot.deleteMany({ where: { institutionId, academicYearId: year.id } });
    await tx.timeSlot.createMany({ data: rows.map((r, i) => ({ id: randomUUID(), institutionId, academicYearId: year.id, order: i + 1, ...r })) });
    await tx.timetableSettings.upsert({
      where: { institutionId_academicYearId: { institutionId, academicYearId: year.id } },
      create: { institutionId, academicYearId: year.id, workingDays: days },
      update: { workingDays: days },
    });
  });
  return { slots: rows.length, ends: hhmm(t) };
}

// ── Weekly periods per subject ────────────────────────────────────────────────
// A sensible starting point by subject; the admin changes any number in one tap.
const WEIGHTS: [RegExp, number][] = [
  [/math/i, 7], [/english/i, 6], [/science|evs|environment/i, 6], [/physics|chemistry|biology/i, 6],
  [/account|economic|business|commerce/i, 6], [/social|sst|history|geograph|civics|political/i, 5],
  [/hindi|marathi|gujarati|tamil|telugu|kannada|bengali|urdu|punjabi|malayalam|odia|language/i, 5],
  [/sanskrit|french|german|spanish/i, 3], [/computer|ict|information|coding|robotic/i, 2],
  [/p\.?\s?t\b|physical|sport|games|yoga/i, 2], [/art|draw|craft|paint/i, 2], [/music|dance/i, 1],
  [/library/i, 1], [/g\.?\s?k\b|general knowledge|moral|value|life skill/i, 1],
];
const weightOf = (name: string) => WEIGHTS.find(([re]) => re.test(name))?.[1] ?? 4;

export async function suggestRequirements(institutionId: string, year: AcademicYear) {
  const db = academicDb();
  const ctx = await loadYearContext(institutionId, year);
  const perWeek = ctx.slots.filter((s) => s.kind === "PERIOD").length * ctx.workingDays.length;
  const [standards, subjects, divisionSubjects, configs] = await Promise.all([
    db.standard.findMany({ where: { institutionId }, select: { id: true, name: true, order: true, divisions: { select: { id: true } } }, orderBy: { order: "asc" } }),
    db.subject.findMany({ where: { institutionId }, select: { id: true, name: true, standardId: true }, orderBy: { order: "asc" } }),
    db.divisionSubject.findMany({ where: { institutionId }, select: { divisionId: true, subjectId: true } }),
    db.timetableSubjectConfig.findMany({ where: { institutionId, academicYearId: year.id }, select: { divisionId: true, subjectId: true, title: true, periodsPerWeek: true, span: true, roomType: true, teacherId: true } }),
  ]);
  return {
    periodsPerWeek: perWeek,
    standards: standards.filter((s) => s.divisions.length).map((s) => {
      const divIds = new Set(s.divisions.map((d) => d.id));
      const taught = new Set(divisionSubjects.filter((x) => divIds.has(x.divisionId)).map((x) => x.subjectId));
      const list = subjects.filter((x) => x.standardId === s.id && (!taught.size || taught.has(x.id)));
      const saved = configs.filter((c) => divIds.has(c.divisionId));
      // Already set for this class: keep what the school chose (first section's numbers).
      if (saved.length) {
        const first = s.divisions.find((d) => saved.some((c) => c.divisionId === d.id))!.id;
        const own = saved.filter((c) => c.divisionId === first);
        // A subject can have a class-room part and a lab part (two rows, the lab one has a room type).
        // Each part may be split in two rows: single periods and double periods.
        const sum = (rows: typeof own) => ({ periods: rows.reduce((n, c) => n + c.periodsPerWeek, 0), doubles: rows.filter((c) => c.span > 1).reduce((n, c) => n + Math.floor(c.periodsPerWeek / 2), 0) });
        return {
          standardId: s.id, name: s.name, saved: true,
          items: list.map((x) => {
            const theory = sum(own.filter((c) => c.subjectId === x.id && !c.roomType));
            const labRows = own.filter((c) => c.subjectId === x.id && c.roomType);
            const lab = sum(labRows);
            return {
              subjectId: x.id, name: x.name, periodsPerWeek: theory.periods, doubles: theory.doubles,
              lab: labRows.length ? { roomType: labRows[0].roomType!, periodsPerWeek: lab.periods, doubles: lab.doubles } : null,
            };
          }),
          activities: own.filter((c) => !c.subjectId && c.title).map((c) => ({ title: c.title!, periodsPerWeek: c.periodsPerWeek, teacherId: c.teacherId, roomType: c.roomType })),
        };
      }
      return { standardId: s.id, name: s.name, saved: false, items: fit(list, perWeek).map((i) => ({ ...i, doubles: 0, lab: null })), activities: [] };
    }),
  };
}

/** Weights scaled to fill the week, each subject at least 1 and at most 2 a day. */
function fit(list: { id: string; name: string }[], perWeek: number) {
  if (!list.length || !perWeek) return list.map((x) => ({ subjectId: x.id, name: x.name, periodsPerWeek: 0 }));
  const w = list.map((x) => weightOf(x.name));
  const total = w.reduce((a, b) => a + b, 0);
  const n = w.map((x) => Math.max(1, Math.round((x / total) * perWeek)));
  let sum = n.reduce((a, b) => a + b, 0);
  const order = w.map((x, i) => [x, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  for (let k = 0; sum > perWeek && k < 500; k++) { const i = order[k % order.length]; if (n[i] > 1) { n[i]--; sum--; } }
  for (let k = 0; sum < perWeek && k < 500; k++) { const i = order[k % order.length]; n[i]++; sum++; }
  return list.map((x, i) => ({ subjectId: x.id, name: x.name, periodsPerWeek: n[i] }));
}

export const requirementsSchema = z.object({
  standards: z.array(z.object({
    standardId: z.string().min(1).max(64),
    items: z.array(z.object({
      subjectId: z.string().min(1).max(64),
      periodsPerWeek: z.number().int().min(0).max(40),
      /** How many double periods (two in a row) out of the class-room periods; the rest are single. */
      doubles: z.number().int().min(0).max(20).optional(),
      /** Extra periods of the same subject in a lab (e.g. 2 a week in the Science lab); null = none. */
      lab: z.object({
        roomType: z.string().trim().min(1).max(40),
        periodsPerWeek: z.number().int().min(1).max(20),
        doubles: z.number().int().min(0).max(10).default(0),
      }).nullable().optional(),
    })).max(40),
    /** Library, PT, Music... (no subject). Sent = replaces the class's activities. */
    activities: z.array(z.object({
      title: z.string().trim().min(1).max(80),
      periodsPerWeek: z.number().int().min(1).max(20),
      teacherId: z.string().min(1).max(64).nullable().optional(),
      roomType: z.string().trim().max(40).nullable().optional(),
    })).max(15).optional(),
  })).min(1).max(40),
  /** Teacher picked by the admin for a subject in one section (when none is assigned). */
  teachers: z.array(z.object({ divisionId: z.string().min(1).max(64), subjectId: z.string().min(1).max(64), teacherId: z.string().min(1).max(64) })).max(500).default([]),
}).strict();

/** The same weekly numbers for every section of a class; the teacher comes from the class assignments. */
export async function saveRequirements(institutionId: string, year: AcademicYear, body: z.infer<typeof requirementsSchema>) {
  assertWritable(year);
  const db = academicDb();
  const theory = await theoryType(institutionId);
  const { withTeacher, noTeacher } = await activityTypes(institutionId);
  const pick = new Map(body.teachers.map((t) => [`${t.divisionId}|${t.subjectId}`, t.teacherId]));
  let saved = 0;
  for (const st of body.standards) {
    const divisions = await db.division.findMany({ where: { institutionId, standardId: st.standardId }, select: { id: true } });
    for (const d of divisions) {
      const existing = await db.timetableSubjectConfig.findMany({ where: { institutionId, academicYearId: year.id, divisionId: d.id } });
      const keepOthers = existing.filter((c) => (c.subjectId ? !st.items.some((i) => i.subjectId === c.subjectId) : !st.activities));
      const configs = [
        // Rows this screen does not show (activities, subjects not listed) stay as they are.
        ...keepOthers.map(toItem),
        ...st.items.flatMap((i) => {
          const mine = existing.filter((c) => c.subjectId === i.subjectId);
          const theoryRows = mine.filter((c) => !c.roomType);
          const labRows = mine.filter((c) => c.roomType);
          const teacherId = pick.get(`${d.id}|${i.subjectId}`) ?? theoryRows[0]?.teacherId ?? labRows[0]?.teacherId ?? null;
          const base = { subjectId: i.subjectId, sessionTypeId: theoryRows[0]?.sessionTypeId ?? theory.id, title: null, teacherId, roomId: null };
          const doubles = i.doubles ?? theoryRows.filter((c) => c.span > 1).reduce((n, c) => n + Math.floor(c.periodsPerWeek / 2), 0);
          const rows = splitRows(theoryRows, i.periodsPerWeek, doubles, { ...base, roomType: null });
          // The lab part: same subject and teacher, in a room of the chosen type.
          const lab = i.lab === undefined
            ? (labRows.length ? { roomType: labRows[0].roomType!, periodsPerWeek: labRows.reduce((n, c) => n + c.periodsPerWeek, 0), doubles: labRows.filter((c) => c.span > 1).reduce((n, c) => n + Math.floor(c.periodsPerWeek / 2), 0) } : null)
            : i.lab;
          if (lab) rows.push(...splitRows(labRows, lab.periodsPerWeek, lab.doubles, { ...base, teacherId: labRows[0]?.teacherId ?? teacherId, roomType: lab.roomType }));
          return rows;
        }),
        ...(st.activities ?? []).map((a) => {
          const prev = existing.find((c) => !c.subjectId && c.title?.trim().toLowerCase() === a.title.toLowerCase());
          return {
            ...(prev ? { id: prev.id } : {}), subjectId: null, sessionTypeId: (a.teacherId ? withTeacher : noTeacher).id, title: a.title,
            periodsPerWeek: a.periodsPerWeek, span: 1, maxPerDay: 1, teacherId: a.teacherId ?? null, roomId: null, roomType: a.roomType ?? null,
          };
        }),
      ];
      await saveConfigs(institutionId, year, d.id, { configs });
      saved++;
    }
  }
  return { sections: saved };
}

// ── The AI assistant ──────────────────────────────────────────────────────────
const OpenAIModule = (process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY) ? require("openai") : null;
const ai: import("openai").OpenAI | null = OpenAIModule
  ? new OpenAIModule.OpenAI(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : { apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" })
  : null;
const PROVIDER: "openai" | "groq" = process.env.OPENAI_API_KEY ? "openai" : "groq";
const MODEL = process.env.TIMETABLE_AI_MODEL || (process.env.OPENAI_API_KEY ? "gpt-4.1-mini" : "llama-3.3-70b-versatile");
const FALLBACK_MODEL = process.env.OPENAI_API_KEY ? "gpt-4.1-mini" : "openai/gpt-oss-120b";

/** What the AI may ask the engine to do. Every action is checked on the server before it runs. */
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_periods"), sections: z.array(z.string()).min(1).max(100), subject: z.string().max(80), periods: z.number().int().min(0).max(40) }),
  z.object({ type: z.literal("set_teacher"), sections: z.array(z.string()).min(1).max(100), subject: z.string().max(80), teacher: z.string().max(20) }),
  z.object({ type: z.literal("teacher_off"), teacher: z.string().max(20), days: z.array(z.number().int().min(1).max(7)).min(1).max(7), periods: z.array(z.number().int().min(1).max(20)).max(20).default([]) }),
  z.object({ type: z.literal("teacher_on"), teacher: z.string().max(20), days: z.array(z.number().int().min(1).max(7)).min(1).max(7), periods: z.array(z.number().int().min(1).max(20)).max(20).default([]) }),
  z.object({ type: z.literal("teacher_limits"), teacher: z.string().max(20), maxPerDay: z.number().int().min(1).max(12).nullable().optional(), maxInARow: z.number().int().min(1).max(12).nullable().optional(), maxPerWeek: z.number().int().min(1).max(60).nullable().optional() }),
  z.object({ type: z.literal("move"), section: z.string().max(20), fromDay: z.number().int().min(1).max(7), fromPeriod: z.number().int().min(1).max(20), toDay: z.number().int().min(1).max(7), toPeriod: z.number().int().min(1).max(20) }),
  z.object({ type: z.literal("regenerate"), sections: z.array(z.string()).min(1).max(300) }),
  z.object({ type: z.literal("show"), section: z.string().max(20).optional(), teacher: z.string().max(20).optional() }),
  z.object({ type: z.literal("fix"), sections: z.array(z.string()).min(1).max(300) }),
  z.object({ type: z.literal("class_teacher_first"), sections: z.array(z.string()).min(1).max(300), days: z.array(z.number().int().min(1).max(7)).max(7).default([]), on: z.boolean().default(true) }),
]);
export type TimetableAction = z.infer<typeof actionSchema>;

export const chatSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(2000) })).max(12).default([]),
  focus: z.object({ divisionId: z.string().max(64).optional(), teacherId: z.string().max(64).optional() }).default({}),
  /** The Health score the admin sees on the page, with its reasons. */
  health: z.string().max(1000).optional(),
}).strict();

const PROMPT = `You are the timetable assistant inside a school app. The school's timetable is placed by a scheduling engine that never makes clashes. You help the admin by turning their words into engine actions, and by answering questions from the data below.
Sections are named S1, S2... and teachers T1, T2... (see the lists). Days: 1=Mon ... 7=Sun. Periods are numbered from 1 (teaching periods only, breaks not counted).
Actions you can use:
- {"type":"set_periods","sections":["S1",...] or ["ALL"],"subject":"Maths","periods":7} - periods per week of a subject.
- {"type":"set_teacher","sections":["S1"],"subject":"Hindi","teacher":"T4"} - who teaches a subject in those sections.
- {"type":"teacher_off","teacher":"T3","days":[5],"periods":[8]} - the teacher must be free then (periods [] = the whole day).
- {"type":"teacher_on","teacher":"T3","days":[5],"periods":[]} - remove such free time again.
- {"type":"teacher_limits","teacher":"T3","maxPerDay":6,"maxInARow":3,"maxPerWeek":30} - any of these (null = no limit).
- {"type":"move","section":"S1","fromDay":1,"fromPeriod":2,"toDay":3,"toPeriod":5} - move (or swap) one period of a section.
- {"type":"regenerate","sections":["S1"] or ["ALL"]} - build those sections again (use after rule changes only if the admin asks to rebuild; rule changes rebuild the sections they touch by themselves).
- {"type":"show","section":"S1"} or {"type":"show","teacher":"T3"} - open that timetable on the screen.
- {"type":"fix","sections":["S1"] or ["ALL"]} - fill missing periods / empty periods of those sections without any clash (I find the free times and swaps myself).
- {"type":"class_teacher_first","sections":["S1"] or ["ALL"],"days":[] ,"on":true} - the section's class teacher (see the Sections list) takes the first period of the day with their own subject in that class (days [] = every school day). "on":false lets those periods move again.
Rules:
- Only use the codes from the lists. If the admin names something that is not in the lists, ask which one they mean.
- The codes are only for the actions. NEVER write a code (S1, T2...) in "reply": always write the class name (like 10-A) and the teacher's name.
- You already know each section's class teacher from the Sections list; never ask the admin for it.
- When periods are missing, a period is empty, something does not fit, or the admin says "fix it" / "you decide", use "fix" for those sections. Do not ask the admin which period to move, and do not guess moves yourself.
- Use "move" only when the admin asks to move one particular period.
- The engine cannot pin a subject to certain times (like "Maths only in the morning"). Say so kindly and suggest what can be done (e.g. a move, or a teacher's free time).
- For questions (load, free periods, who teaches what), answer from the data; you may add a "show" action.
- Keep "reply" short, friendly and simple, in the same language the admin writes in (English, Hindi or Hinglish). Say what will change. Never invent numbers.
Reply only JSON: {"reply":"...","actions":[...]}`;

async function schoolSummary(institutionId: string, year: AcademicYear) {
  const ws = await workspace(institutionId, year);
  const sections = ws.standards.flatMap((s) => s.divisions);
  const sCode = new Map(sections.map((d, i) => [d.id, `S${i + 1}`]));
  const tCode = new Map(ws.teachers.map((t, i) => [t.id, `T${i + 1}`]));
  const subjectName = new Map(ws.subjects.map((s) => [s.id, s.name]));
  const periodSlots = ws.slots.filter((s) => s.kind === "PERIOD");
  const periodNo = new Map(periodSlots.map((s, i) => [s.id, i + 1]));
  const load = new Map<string, number>();
  for (const e of ws.entries) if (e.teacherId) load.set(e.teacherId, (load.get(e.teacherId) ?? 0) + 1);
  const offs = new Map<string, string[]>();
  for (const u of ws.unavailable) {
    const p = periodNo.get(u.slotId);
    if (p) offs.set(u.teacherId, [...(offs.get(u.teacherId) ?? []), `${DAY_SHORT[u.dayOfWeek]} P${p}`]);
  }
  const lines = [
    `Days: ${ws.workingDays.map((d) => `${d}=${DAY_SHORT[d]}`).join(", ")}. Periods a day: ${periodSlots.length} (${periodSlots.map((s, i) => `P${i + 1} ${hhmm(s.startMinute)}`).join(", ")}).`,
    `Sections (code=name, class teacher): ${sections.map((d) => `${sCode.get(d.id)}=${d.label}${d.classTeacherId && tCode.get(d.classTeacherId) ? ` class teacher ${tCode.get(d.classTeacherId)}` : " no class teacher"}${d.status === "PUBLISHED" ? " (published)" : ""}`).join(", ")}`,
    `Teachers (code=name, periods a week now${ws.unavailable.length ? ", free time" : ""}): ${ws.teachers.map((t) => `${tCode.get(t.id)}=${t.name} ${load.get(t.id) ?? 0}${offs.get(t.id) ? ` [free ${offs.get(t.id)!.slice(0, 8).join(" ")}]` : ""}`).join("; ")}`,
    "Subjects per section (subject periods/week teacher):",
    ...sections.map((d) => {
      const mine = ws.configs.filter((c) => c.divisionId === d.id);
      return `${sCode.get(d.id)}: ${mine.length ? mine.map((c) => `${c.subjectId ? subjectName.get(c.subjectId) : c.title ?? "Other"} ${c.periodsPerWeek} ${c.teacherId ? tCode.get(c.teacherId) ?? "?" : "no-teacher"}`).join(", ") : "not set"}`;
    }),
  ];
  // What is actually placed, so the assistant can answer "what is missing / who is busiest" questions.
  const runOf = (list: number[]) => { let best = 0, run = 0, prev = -9; for (const n of [...list].sort((x, y) => x - y)) { run = n === prev + 1 ? run + 1 : 1; best = Math.max(best, run); prev = n; } return best; };
  lines.push("Placed now per section (placed/needed, empty periods, subjects short of periods):");
  for (const d of sections) {
    const mine = ws.configs.filter((c) => c.divisionId === d.id);
    const placed = ws.entries.filter((e) => e.divisionId === d.id && periodNo.has(e.slotId));
    const short = mine.flatMap((c) => {
      const got = placed.filter((e) => (c.subjectId ? e.subjectId === c.subjectId : !e.subjectId && e.title === c.title)).length;
      const need = mine.filter((x) => (c.subjectId ? x.subjectId === c.subjectId : !x.subjectId && x.title === c.title)).reduce((n, x) => n + x.periodsPerWeek, 0);
      return got < need ? [`${c.subjectId ? subjectName.get(c.subjectId) : c.title} ${got}/${need}`] : [];
    });
    const need = mine.reduce((n, c) => n + c.periodsPerWeek, 0);
    lines.push(`${sCode.get(d.id)}: ${placed.length}/${need}, empty ${periodSlots.length * ws.workingDays.length - placed.length}${short.length ? `, short: ${[...new Set(short)].join(", ")}` : ""}`);
  }
  lines.push(`Teacher busiest day and longest run of periods in a row: ${ws.teachers.map((t) => {
    const mine = ws.entries.filter((e) => e.teacherId === t.id && periodNo.has(e.slotId));
    const perDay = ws.workingDays.map((d) => mine.filter((e) => e.dayOfWeek === d).map((e) => periodNo.get(e.slotId)!));
    return `${tCode.get(t.id)} day ${Math.max(0, ...perDay.map((l) => l.length))} row ${Math.max(0, ...perDay.map(runOf))}`;
  }).join("; ")}`);
  if (ws.teacherPrefs.length) lines.push(`Teacher limits: ${ws.teacherPrefs.map((p) => `${tCode.get(p.teacherId)} day ${p.maxPeriodsPerDay ?? "-"} row ${p.maxConsecutive ?? "-"} week ${p.maxPeriodsPerWeek ?? "-"}`).join("; ")}`);
  return { ws, sections, sCode, tCode, text: lines.join("\n") };
}

export async function chat(institutionId: string, year: AcademicYear, body: z.infer<typeof chatSchema>, user: { userId: string; role: string }) {
  if (!ai) throw httpError(400, "AI is not set up on this server");
  const { ws, sCode, tCode, text } = await schoolSummary(institutionId, year);
  const focus = [body.focus.divisionId && sCode.get(body.focus.divisionId) ? `The admin is looking at section ${sCode.get(body.focus.divisionId)}.` : "", body.focus.teacherId && tCode.get(body.focus.teacherId) ? `The admin is looking at teacher ${tCode.get(body.focus.teacherId)}.` : ""].filter(Boolean).join(" ");
  const base = { institutionId, userId: user.userId, userRole: user.role, feature: "TIMETABLE_AI" as const, provider: PROVIDER, model: MODEL, requestType: "chat" };
  const messages = [
    { role: "system" as const, content: `${PROMPT}\n\nSCHOOL DATA\n${text}${focus ? `\n${focus}` : ""}${body.health ? `\nHealth score shown to the admin (100% = all placed, no clashes, nobody over 4 periods in a row, even days): ${body.health}` : ""}` },
    ...body.history.map((h) => ({ role: h.role, content: h.text })),
    { role: "user" as const, content: body.message },
  ];
  // Try the main model in JSON mode; if the provider rejects it (bad JSON, model gone...), try without
  // JSON mode and then the fallback model, so one provider hiccup does not leave the admin without an answer.
  const attempts: { model: string; json: boolean }[] = [{ model: MODEL, json: true }, { model: MODEL, json: false }];
  if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) attempts.push({ model: FALLBACK_MODEL, json: false });
  let completion;
  let lastErr: unknown;
  for (const at of attempts) {
    try {
      completion = await ai.chat.completions.create({
        model: at.model, temperature: 0.1, max_tokens: 1500, messages,
        ...(at.json ? { response_format: { type: "json_object" as const } } : {}),
      });
      break;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[timetable-ai] ${at.model}${at.json ? " (json)" : ""} failed: ${msg}`);
      await recordAiUsage({ ...base, model: at.model, status: "FAILED", error: msg });
      if ((err as { status?: number })?.status === 429) throw httpError(429, "The AI is busy right now. Please try again in a minute.");
      if ((err as { status?: number })?.status === 401) throw httpError(502, "The AI key on the server is not valid. Ask your admin to check it.");
    }
  }
  if (!completion) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "");
    throw httpError(502, `The AI could not answer. Please try again.${msg ? ` (${msg.slice(0, 140)})` : ""}`);
  }
  await recordAiUsage({ ...base, status: "SUCCESS", inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens, totalTokens: completion.usage?.total_tokens });
  const raw = completion.choices[0]?.message?.content ?? "";
  let parsed: { reply?: unknown; actions?: unknown } = {};
  try { parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { /* answer as text below */ }
  // Plain text (when JSON mode was not available) is still a fine answer.
  const plain = raw.replace(/```(json)?/g, "").trim();
  let reply = typeof parsed.reply === "string" ? parsed.reply.slice(0, 2000) : plain && !plain.startsWith("{") ? plain.slice(0, 2000) : "Sorry, I did not get that. Please say it in another way.";
  // The admin never sees the internal codes: S1 -> 10-A, T2 -> the teacher's name.
  const sName = new Map([...sCode].map(([id, c]) => [c, ws.standards.flatMap((x) => x.divisions).find((d) => d.id === id)?.label ?? c]));
  const tName = new Map([...tCode].map(([id, c]) => [c, ws.teachers.find((t) => t.id === id)?.name ?? c]));
  reply = reply.replace(/\b([ST])(\d{1,3})\b/g, (m) => (m[0] === "S" ? sName.get(m) : tName.get(m)) ?? m);
  const actions: TimetableAction[] = (Array.isArray(parsed.actions) ? parsed.actions : []).flatMap((a) => { const r = actionSchema.safeParse(a); return r.success ? [r.data] : []; }).slice(0, 20);
  const plan = describeActions(ws, sCode, tCode, actions);
  return { reply, actions: plan.actions, steps: plan.steps, show: plan.show };
}

type Ws = Awaited<ReturnType<typeof workspace>>;

/** Turns the AI's codes into ids, drops what does not exist, and writes each step in plain words. */
function describeActions(ws: Ws, sCode: Map<string, string>, tCode: Map<string, string>, actions: TimetableAction[]) {
  const sections = ws.standards.flatMap((s) => s.divisions);
  const byS = new Map([...sCode].map(([id, c]) => [c, id]));
  const byT = new Map([...tCode].map(([id, c]) => [c, id]));
  const sectionIds = (list: string[]) => (list.includes("ALL") ? sections.map((d) => d.id) : list.map((c) => byS.get(c)).filter((x): x is string => !!x));
  const label = (id: string) => sections.find((d) => d.id === id)?.label ?? "?";
  const tName = (id: string) => ws.teachers.find((t) => t.id === id)?.name ?? "?";
  const periods = ws.slots.filter((s) => s.kind === "PERIOD");
  const out: ResolvedAction[] = [];
  const steps: string[] = [];
  let show: { divisionId?: string; teacherId?: string } | null = null;
  const subjectIn = (divisionId: string, name: string) => {
    const st = ws.standards.find((s) => s.divisions.some((d) => d.id === divisionId));
    const n = name.trim().toLowerCase();
    return ws.subjects.find((x) => x.standardId === st?.id && x.name.trim().toLowerCase() === n)
      ?? ws.subjects.find((x) => x.standardId === st?.id && x.name.toLowerCase().includes(n));
  };
  const list = (ids: string[]) => (ids.length === sections.length && ids.length > 3 ? "all sections" : ids.length > 4 ? `${ids.length} sections` : ids.map(label).join(", "));
  for (const a of actions) {
    if (a.type === "set_periods" || a.type === "set_teacher") {
      const ids = sectionIds(a.sections);
      const pairs = ids.map((d) => ({ divisionId: d, subjectId: subjectIn(d, a.subject)?.id })).filter((p): p is { divisionId: string; subjectId: string } => !!p.subjectId);
      if (!pairs.length) continue;
      if (a.type === "set_periods") {
        out.push({ type: "set_periods", pairs, periods: a.periods });
        steps.push(`${a.subject}: ${a.periods} period${a.periods === 1 ? "" : "s"} a week in ${list(pairs.map((p) => p.divisionId))}`);
      } else {
        const teacherId = byT.get(a.teacher);
        if (!teacherId) continue;
        out.push({ type: "set_teacher", pairs, teacherId });
        steps.push(`${tName(teacherId)} teaches ${a.subject} in ${list(pairs.map((p) => p.divisionId))}`);
      }
    } else if (a.type === "teacher_off" || a.type === "teacher_on") {
      const teacherId = byT.get(a.teacher);
      if (!teacherId) continue;
      const slotIds = (a.periods.length ? a.periods.map((p) => periods[p - 1]?.id).filter((x): x is string => !!x) : periods.map((s) => s.id));
      const days = a.days.filter((d) => ws.workingDays.includes(d));
      if (!slotIds.length || !days.length) continue;
      out.push({ type: a.type, teacherId, days, slotIds });
      const when = `${days.map((d) => DAY_SHORT[d]).join(", ")}${a.periods.length ? ` period ${a.periods.join(", ")}` : " (whole day)"}`;
      steps.push(a.type === "teacher_off" ? `${tName(teacherId)} free on ${when}` : `${tName(teacherId)} can teach again on ${when}`);
    } else if (a.type === "teacher_limits") {
      const teacherId = byT.get(a.teacher);
      if (!teacherId) continue;
      out.push({ type: "teacher_limits", teacherId, maxPerDay: a.maxPerDay, maxInARow: a.maxInARow, maxPerWeek: a.maxPerWeek });
      steps.push(`${tName(teacherId)}: ${[a.maxPerDay !== undefined ? `at most ${a.maxPerDay ?? "any"} a day` : "", a.maxInARow !== undefined ? `at most ${a.maxInARow ?? "any"} in a row` : "", a.maxPerWeek !== undefined ? `at most ${a.maxPerWeek ?? "any"} a week` : ""].filter(Boolean).join(", ")}`);
    } else if (a.type === "move") {
      const divisionId = byS.get(a.section);
      const from = periods[a.fromPeriod - 1], to = periods[a.toPeriod - 1];
      if (!divisionId || !from || !to) continue;
      // Check the move against the real timetable: a teacher may not be in two classes at once.
      const at = (d: string, day: number, slot: string) => ws.entries.find((e) => e.divisionId === d && e.dayOfWeek === day && e.slotId === slot);
      const busy = (t: string | null, day: number, slot: string) => !!t && (ws.entries.some((e) => e.teacherId === t && e.divisionId !== divisionId && e.dayOfWeek === day && e.slotId === slot) || ws.unavailable.some((u) => u.teacherId === t && u.dayOfWeek === day && u.slotId === slot));
      const moving = at(divisionId, a.fromDay, from.id);
      const there = at(divisionId, a.toDay, to.id);
      if (!moving || busy(moving.teacherId, a.toDay, to.id) || (there && busy(there.teacherId, a.fromDay, from.id))) {
        if (!out.some((o) => o.type === "fix" && o.divisionIds.includes(divisionId))) out.push({ type: "fix", divisionIds: [divisionId] });
        steps.push(`${label(divisionId)}: that move would clash, so I will fill the gaps at times when every teacher is free`);
        continue;
      }
      out.push({ type: "move", divisionId, fromDay: a.fromDay, fromSlotId: from.id, toDay: a.toDay, toSlotId: to.id });
      steps.push(`${label(divisionId)}: move ${DAY_SHORT[a.fromDay]} period ${a.fromPeriod} to ${DAY_SHORT[a.toDay]} period ${a.toPeriod}`);
    } else if (a.type === "regenerate") {
      const ids = sectionIds(a.sections);
      if (!ids.length) continue;
      out.push({ type: "regenerate", divisionIds: ids });
      steps.push(`Build ${list(ids)} again`);
    } else if (a.type === "fix") {
      const ids = sectionIds(a.sections);
      if (!ids.length) continue;
      out.push({ type: "fix", divisionIds: ids });
      steps.push(`${list(ids)}: fill missing periods at times when the teacher is free (moving other periods if needed), no clashes`);
    } else if (a.type === "class_teacher_first") {
      const days = (a.days.length ? a.days : ws.workingDays).filter((d) => ws.workingDays.includes(d));
      const all = sectionIds(a.sections);
      const ok = all.filter((id) => {
        const ct = sections.find((d) => d.id === id)?.classTeacherId;
        return !!ct && (!a.on || ws.configs.some((c) => c.divisionId === id && c.teacherId === ct && !c.roomType));
      });
      for (const id of all.filter((x) => !ok.includes(x))) {
        const ct = sections.find((d) => d.id === id)?.classTeacherId;
        steps.push(ct ? `${label(id)}: skipped, ${tName(ct)} does not teach a subject in this class` : `${label(id)}: skipped, no class teacher is set (Campus > Classes)`);
      }
      if (!ok.length || !days.length) continue;
      out.push({ type: "class_teacher_first", divisionIds: ok, days, on: a.on });
      const when = days.length === ws.workingDays.length ? "every day" : days.map((d) => DAY_SHORT[d]).join(", ");
      for (const id of ok) {
        const ct = sections.find((d) => d.id === id)!.classTeacherId!;
        steps.push(a.on ? `${label(id)}: ${tName(ct)} (class teacher) takes period 1 ${when}, kept fixed` : `${label(id)}: period 1 of ${tName(ct)} can move again`);
      }
      if (a.on) steps.push("Build those classes again around it");
    } else if (a.type === "show") {
      const divisionId = a.section ? byS.get(a.section) : undefined;
      const teacherId = a.teacher ? byT.get(a.teacher) : undefined;
      if (divisionId || teacherId) show = { divisionId, teacherId };
    }
  }
  return { actions: out, steps, show };
}

type ConfigItem = z.infer<typeof configItemSchema>;
const toItem = (c: { id: string; subjectId: string | null; sessionTypeId: string; title: string | null; periodsPerWeek: number; span: number; maxPerDay: number; teacherId: string | null; roomId: string | null; roomType: string | null }): ConfigItem => ({
  id: c.id, subjectId: c.subjectId, sessionTypeId: c.sessionTypeId, title: c.title, periodsPerWeek: c.periodsPerWeek, span: c.span, maxPerDay: c.maxPerDay, teacherId: c.teacherId, roomId: c.roomId, roomType: c.roomType,
});
/** Session types for activities: one that needs a teacher, one that does not (free/study style). */
async function activityTypes(institutionId: string) {
  const db = academicDb();
  const types = await ensureSessionTypes(institutionId);
  const withTeacher = types.find((x) => x.kind === "ACTIVITY" && x.isActive && x.requiresTeacher && !x.requiresRoom)
    ?? await db.timetableSessionType.create({ data: { institutionId, name: "Activity", kind: "ACTIVITY", requiresTeacher: true, requiresRoom: false, defaultSpan: 1, color: "#f59e0b" } });
  const noTeacher = types.find((x) => x.isActive && !x.requiresTeacher && !x.requiresRoom && (x.kind === "ACTIVITY" || x.kind === "FREE"))
    ?? await db.timetableSessionType.create({ data: { institutionId, name: "Activity (no teacher)", kind: "ACTIVITY", requiresTeacher: false, requiresRoom: false, defaultSpan: 1, color: "#f59e0b" } });
  return { withTeacher, noTeacher };
}

/**
 * One part of a subject (class-room or lab) as config rows: `doubles` blocks of two periods in a row, and the
 * rest as single periods. Reuses the old rows' ids so placed periods keep their link.
 */
function splitRows(prev: { id: string; span: number; sessionTypeId: string }[], total: number, doubles: number, base: Omit<ConfigItem, "periodsPerWeek" | "span" | "maxPerDay" | "id" | "sessionTypeId"> & { sessionTypeId: string }): ConfigItem[] {
  const d = Math.max(0, Math.min(doubles, Math.floor(total / 2)));
  const singles = total - d * 2;
  const prevSingle = prev.find((c) => c.span <= 1);
  const prevDouble = prev.find((c) => c.span > 1);
  const out: ConfigItem[] = [];
  if (singles > 0) out.push({ ...base, ...(prevSingle ? { id: prevSingle.id, sessionTypeId: prevSingle.sessionTypeId } : {}), periodsPerWeek: singles, span: 1, maxPerDay: singles > 6 ? 2 : 1 });
  if (d > 0) out.push({ ...base, ...(prevDouble ? { id: prevDouble.id, sessionTypeId: prevDouble.sessionTypeId } : {}), periodsPerWeek: d * 2, span: 2, maxPerDay: 2 });
  return out;
}

async function theoryType(institutionId: string) {
  const types = await ensureSessionTypes(institutionId);
  const t = types.find((x) => x.kind === "THEORY" && x.isActive) ?? types.find((x) => x.requiresTeacher && !x.requiresRoom);
  if (!t) throw httpError(400, "No teaching session type found");
  return t;
}

const resolvedSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_periods"), pairs: z.array(z.object({ divisionId: z.string(), subjectId: z.string() })).min(1).max(300), periods: z.number().int().min(0).max(40) }),
  z.object({ type: z.literal("set_teacher"), pairs: z.array(z.object({ divisionId: z.string(), subjectId: z.string() })).min(1).max(300), teacherId: z.string() }),
  z.object({ type: z.enum(["teacher_off", "teacher_on"]), teacherId: z.string(), days: z.array(z.number().int().min(1).max(7)).min(1).max(7), slotIds: z.array(z.string()).min(1).max(20) }),
  z.object({ type: z.literal("teacher_limits"), teacherId: z.string(), maxPerDay: z.number().int().nullable().optional(), maxInARow: z.number().int().nullable().optional(), maxPerWeek: z.number().int().nullable().optional() }),
  z.object({ type: z.literal("move"), divisionId: z.string(), fromDay: z.number().int(), fromSlotId: z.string(), toDay: z.number().int(), toSlotId: z.string() }),
  z.object({ type: z.literal("regenerate"), divisionIds: z.array(z.string()).min(1).max(300) }),
  z.object({ type: z.literal("fix"), divisionIds: z.array(z.string()).min(1).max(300) }),
  z.object({ type: z.literal("class_teacher_first"), divisionIds: z.array(z.string()).min(1).max(300), days: z.array(z.number().int().min(1).max(7)).min(1).max(7), on: z.boolean() }),
]);
type ResolvedAction = z.infer<typeof resolvedSchema>;
export const applySchema = z.object({ actions: z.array(resolvedSchema).min(1).max(20) }).strict();

/**
 * Fills the periods a section is still short of, without clashes: first in an empty period when the
 * teacher is free; else by moving one of the section's own periods into an empty one (its teacher
 * free then) and using the freed time. Whatever still does not fit is built again by the engine
 * (which may also shift other sections that are not published). Returns the sections to build again.
 */
async function fixSections(institutionId: string, year: AcademicYear, divisionIds: string[], actor: Actor) {
  const db = academicDb();
  const ctx = await loadYearContext(institutionId, year);
  const periods = ctx.slots.filter((s) => s.kind === "PERIOD");
  const rebuild = new Set<string>();
  for (const divisionId of divisionIds) {
    const all = await db.timetableEntry.findMany({ where: { institutionId, academicYearId: year.id }, select: { id: true, divisionId: true, dayOfWeek: true, slotId: true, subjectId: true, title: true, teacherId: true, configId: true, groupId: true, isLocked: true } });
    const mine = all.filter((e) => e.divisionId === divisionId);
    const configs = (await loadEngineConfigs(institutionId, year.id, [divisionId])).filter((c) => c.span <= 1 && !c.roomType && !c.roomId);
    const taken = new Set(mine.map((e) => `${e.dayOfWeek}|${e.slotId}`));
    const empty = ctx.workingDays.flatMap((d) => periods.filter((p) => !taken.has(`${d}|${p.id}`)).map((p) => ({ day: d, slotId: p.id })));
    const busy = (t: string | null, day: number, slotId: string, ignoreId?: string) => !!t && (
      ctx.teacherUnavailable.has(`${t}|${day}|${slotId}`) ||
      all.some((e) => e.id !== ignoreId && e.teacherId === t && e.dayOfWeek === day && e.slotId === slotId && e.divisionId !== divisionId)
    );
    const sameDay = (c: { subjectId: string | null; label: string }, day: number) => mine.some((e) => e.dayOfWeek === day && (c.subjectId ? e.subjectId === c.subjectId : e.title === c.label));
    let left = 0;
    const add: { dayOfWeek: number; slotId: string; sessionTypeId: string; subjectId: string | null; title: string | null; teacherId: string | null; configId: string }[] = [];
    for (const c of configs) {
      const got = mine.filter((e) => e.configId === c.id || (!e.configId && (c.subjectId ? e.subjectId === c.subjectId : e.title === c.label))).length + add.filter((a) => a.configId === c.id).length;
      for (let k = got; k < c.periodsPerWeek; k++) {
        // 1) an empty period when the teacher is free (a day without this subject first)
        const free = empty.filter((x) => !busy(c.teacherId, x.day, x.slotId)).sort((x, y) => Number(sameDay(c, x.day)) - Number(sameDay(c, y.day)))[0];
        if (free) {
          empty.splice(empty.indexOf(free), 1);
          add.push({ dayOfWeek: free.day, slotId: free.slotId, sessionTypeId: c.sessionTypeId, subjectId: c.subjectId ?? null, title: c.subjectId ? null : c.label, teacherId: c.teacherId, configId: c.id });
          continue;
        }
        // 2) move one of this section's periods into an empty one, and use the time it frees
        let done = false;
        for (const x of empty) {
          const mover = mine.find((e) => !e.isLocked && !e.groupId && !busy(e.teacherId, x.day, x.slotId, e.id) && !busy(c.teacherId, e.dayOfWeek, e.slotId));
          if (!mover) continue;
          const freed = { day: mover.dayOfWeek, slotId: mover.slotId };
          await db.timetableEntry.update({ where: { id: mover.id }, data: { dayOfWeek: x.day, slotId: x.slotId } });
          mover.dayOfWeek = x.day; mover.slotId = x.slotId;
          const inAll = all.find((e) => e.id === mover.id); if (inAll) { inAll.dayOfWeek = x.day; inAll.slotId = x.slotId; }
          empty.splice(empty.indexOf(x), 1);
          add.push({ dayOfWeek: freed.day, slotId: freed.slotId, sessionTypeId: c.sessionTypeId, subjectId: c.subjectId ?? null, title: c.subjectId ? null : c.label, teacherId: c.teacherId, configId: c.id });
          done = true;
          break;
        }
        if (!done) left++;
      }
    }
    if (add.length) await restoreEntries(institutionId, year, divisionId, { entries: add }, actor);
    // Doubles and lab periods, or anything that still does not fit: let the engine rebuild the section.
    const needAll = (await loadEngineConfigs(institutionId, year.id, [divisionId])).reduce((n, c) => n + c.periodsPerWeek, 0);
    const placedNow = mine.length + add.length;
    if (left > 0 || placedNow < needAll) rebuild.add(divisionId);
  }
  return rebuild;
}

/**
 * "The class teacher takes the first period": for each section, the first teaching period of the
 * chosen days gets one of the class teacher's own subjects in that class, kept fixed (locked), so
 * every later build keeps it. The class teacher's other periods at that time (in any class) are
 * removed so the sections can be built again around it. Returns the sections to build again.
 */
async function classTeacherFirst(institutionId: string, year: AcademicYear, divisionIds: string[], days: number[], on: boolean, actor: Actor) {
  const db = academicDb();
  const ctx = await loadYearContext(institutionId, year);
  const first = ctx.slots.find((s) => s.kind === "PERIOD");
  const rebuild = new Set<string>();
  if (!first) return rebuild;
  const divisions = await db.division.findMany({ where: { institutionId, id: { in: divisionIds } }, select: { id: true, classTeacherId: true } });
  for (const div of divisions) {
    const ct = div.classTeacherId;
    if (!ct) continue;
    const cells = await db.timetableEntry.findMany({ where: { institutionId, academicYearId: year.id, divisionId: div.id, slotId: first.id, dayOfWeek: { in: days } } });
    if (!on) {
      const mine = cells.filter((e) => e.teacherId === ct && e.isLocked);
      if (mine.length) await db.timetableEntry.updateMany({ where: { id: { in: mine.map((e) => e.id) } }, data: { isLocked: false } });
      rebuild.add(div.id);
      continue;
    }
    // The class teacher's own class-room subjects here, most periods first.
    const configs = (await loadEngineConfigs(institutionId, year.id, [div.id])).filter((c) => c.teacherId === ct && !c.roomType && !c.roomId).sort((x, y) => y.periodsPerWeek - x.periodsPerWeek);
    if (!configs.length) continue;
    const left = new Map(configs.map((c) => [c.id, c.periodsPerWeek]));
    const add: { dayOfWeek: number; slotId: string; sessionTypeId: string; subjectId: string | null; title: string | null; teacherId: string; configId: string; isLocked: boolean }[] = [];
    for (const day of days) {
      const here = cells.find((e) => e.dayOfWeek === day);
      if (here?.teacherId === ct) { if (!here.isLocked) await db.timetableEntry.update({ where: { id: here.id }, data: { isLocked: true } }); continue; }
      if (here?.isLocked) continue; // something else is already fixed here
      const cfg = [...configs].sort((x, y) => (left.get(y.id) ?? 0) - (left.get(x.id) ?? 0))[0];
      if (!cfg || (left.get(cfg.id) ?? 0) <= 0) break;
      left.set(cfg.id, (left.get(cfg.id) ?? 0) - 1);
      if (here) await db.timetableEntry.delete({ where: { id: here.id } });
      // The class teacher cannot be in another class at that time.
      const busy = await db.timetableEntry.findMany({ where: { institutionId, academicYearId: year.id, teacherId: ct, dayOfWeek: day, slotId: first.id, isLocked: false, divisionId: { not: div.id } }, select: { id: true, divisionId: true } });
      if (busy.length) {
        await db.timetableEntry.deleteMany({ where: { id: { in: busy.map((b) => b.id) } } });
        for (const b of busy) rebuild.add(b.divisionId);
      }
      add.push({ dayOfWeek: day, slotId: first.id, sessionTypeId: cfg.sessionTypeId, subjectId: cfg.subjectId ?? null, title: cfg.subjectId ? null : cfg.label ?? null, teacherId: ct, configId: cfg.id, isLocked: true });
    }
    if (add.length) await restoreEntries(institutionId, year, div.id, { entries: add }, actor);
    rebuild.add(div.id);
  }
  return rebuild;
}

/**
 * Runs the confirmed steps. Rule changes return the sections to build again
 * (the page rebuilds them one by one, so the admin sees it happen); moves are done here.
 */
export async function applyActions(institutionId: string, year: AcademicYear, body: z.infer<typeof applySchema>, actor: Actor) {
  assertWritable(year);
  const db = academicDb();
  const rebuild = new Set<string>();
  const validDivisions = new Set((await db.division.findMany({ where: { institutionId }, select: { id: true } })).map((d) => d.id));
  const validTeachers = new Set((await db.teacher.findMany({ where: { institutionId }, select: { id: true } })).map((t) => t.id));
  const teachersOf = async (teacherId: string) => new Set((await db.timetableEntry.findMany({ where: { institutionId, academicYearId: year.id, teacherId }, select: { divisionId: true } })).map((e) => e.divisionId));
  for (const a of body.actions) {
    if (a.type === "set_periods" || a.type === "set_teacher") {
      if (a.type === "set_teacher" && !validTeachers.has(a.teacherId)) continue;
      for (const p of a.pairs) {
        if (!validDivisions.has(p.divisionId)) continue;
        const existing = await db.timetableSubjectConfig.findMany({ where: { institutionId, academicYearId: year.id, divisionId: p.divisionId } });
        const row = existing.find((c) => c.subjectId === p.subjectId && !c.roomType) ?? existing.find((c) => c.subjectId === p.subjectId);
        if (a.type === "set_teacher" && !row) continue; // the subject has no weekly periods in this section
        if (a.type === "set_teacher") {
          await saveConfigs(institutionId, year, p.divisionId, { configs: existing.map((c) => ({ ...toItem(c), ...(c.subjectId === p.subjectId ? { teacherId: a.teacherId } : {}) })) });
          rebuild.add(p.divisionId);
          continue;
        }
        const theoryRows = existing.filter((c) => c.subjectId === p.subjectId && !c.roomType);
        const configs: ConfigItem[] = existing.filter((c) => !theoryRows.includes(c)).map(toItem);
        const doubles = theoryRows.filter((c) => c.span > 1).reduce((n, c) => n + Math.floor(c.periodsPerWeek / 2), 0);
        configs.push(...splitRows(theoryRows, a.periods, doubles, {
          subjectId: p.subjectId, sessionTypeId: theoryRows[0]?.sessionTypeId ?? (await theoryType(institutionId)).id, title: null,
          teacherId: theoryRows[0]?.teacherId ?? row?.teacherId ?? null, roomId: null, roomType: null,
        }));
        await saveConfigs(institutionId, year, p.divisionId, { configs });
        rebuild.add(p.divisionId);
      }
    } else if (a.type === "teacher_off" || a.type === "teacher_on") {
      if (!validTeachers.has(a.teacherId)) continue;
      const rows = await db.teacherAvailability.findMany({ where: { institutionId, academicYearId: year.id, teacherId: a.teacherId } });
      const key = (d: number, s: string) => `${d}|${s}`;
      const target = new Set(a.days.flatMap((d) => a.slotIds.map((s) => key(d, s))));
      const unavailable = new Map(rows.filter((r) => r.kind === "UNAVAILABLE").map((r) => [key(r.dayOfWeek, r.slotId), { dayOfWeek: r.dayOfWeek, slotId: r.slotId }]));
      if (a.type === "teacher_off") for (const k of target) { const [d, s] = k.split("|"); unavailable.set(k, { dayOfWeek: Number(d), slotId: s }); }
      else for (const k of target) unavailable.delete(k);
      const preferred = rows.filter((r) => r.kind === "PREFERRED" && !unavailable.has(key(r.dayOfWeek, r.slotId)));
      await db.$transaction([
        db.teacherAvailability.deleteMany({ where: { institutionId, academicYearId: year.id, teacherId: a.teacherId } }),
        db.teacherAvailability.createMany({
          data: [
            ...[...unavailable.values()].map((c) => ({ institutionId, academicYearId: year.id, teacherId: a.teacherId, dayOfWeek: c.dayOfWeek, slotId: c.slotId, kind: "UNAVAILABLE" as const })),
            ...preferred.map((c) => ({ institutionId, academicYearId: year.id, teacherId: a.teacherId, dayOfWeek: c.dayOfWeek, slotId: c.slotId, kind: "PREFERRED" as const })),
          ],
          skipDuplicates: true,
        }),
      ]);
      for (const d of await teachersOf(a.teacherId)) rebuild.add(d);
    } else if (a.type === "teacher_limits") {
      if (!validTeachers.has(a.teacherId)) continue;
      const prev = await db.teacherTimetablePref.findUnique({ where: { teacherId_academicYearId: { teacherId: a.teacherId, academicYearId: year.id } } });
      const data = {
        maxPeriodsPerDay: a.maxPerDay !== undefined ? a.maxPerDay : prev?.maxPeriodsPerDay ?? null,
        maxConsecutive: a.maxInARow !== undefined ? a.maxInARow : prev?.maxConsecutive ?? null,
        maxPeriodsPerWeek: a.maxPerWeek !== undefined ? a.maxPerWeek : prev?.maxPeriodsPerWeek ?? null,
      };
      await db.teacherTimetablePref.upsert({ where: { teacherId_academicYearId: { teacherId: a.teacherId, academicYearId: year.id } }, create: { institutionId, academicYearId: year.id, teacherId: a.teacherId, ...data }, update: data });
      for (const d of await teachersOf(a.teacherId)) rebuild.add(d);
    } else if (a.type === "move") {
      if (!validDivisions.has(a.divisionId)) continue;
      const tt = await db.schoolTimetable.findUnique({ where: { divisionId_academicYearId: { divisionId: a.divisionId, academicYearId: year.id } } });
      if (!tt) continue;
      const from = await db.timetableEntry.findFirst({ where: { timetableId: tt.id, dayOfWeek: a.fromDay, slotId: a.fromSlotId } });
      if (!from) throw httpError(400, "There is no period there to move.");
      const there = await db.timetableEntry.findFirst({ where: { timetableId: tt.id, dayOfWeek: a.toDay, slotId: a.toSlotId } });
      if (from.isLocked) await db.timetableEntry.update({ where: { id: from.id }, data: { isLocked: false } });
      try {
        if (there) await swapEntries(institutionId, year, { entryAId: from.id, entryBId: there.id }, actor);
        else await moveEntry(institutionId, year, { entryId: from.id, toDayOfWeek: a.toDay, toSlotId: a.toSlotId }, actor);
      } catch (err) {
        // It would clash after all: fill the gaps in a way that does not clash instead.
        if (!(err instanceof TimetableConflictError)) throw err;
        if (from.isLocked) await db.timetableEntry.update({ where: { id: from.id }, data: { isLocked: true } });
        for (const d of await fixSections(institutionId, year, [a.divisionId], actor)) rebuild.add(d);
      }
    } else if (a.type === "regenerate") {
      for (const d of a.divisionIds) if (validDivisions.has(d)) rebuild.add(d);
    } else if (a.type === "fix") {
      for (const d of await fixSections(institutionId, year, a.divisionIds.filter((x) => validDivisions.has(x)), actor)) rebuild.add(d);
    } else if (a.type === "class_teacher_first") {
      for (const d of await classTeacherFirst(institutionId, year, a.divisionIds.filter((x) => validDivisions.has(x)), a.days, a.on, actor)) rebuild.add(d);
    }
  }
  // A published timetable goes back to draft so it can be built again; the page asks to publish again.
  const published = await db.schoolTimetable.findMany({ where: { institutionId, academicYearId: year.id, divisionId: { in: [...rebuild] }, status: "PUBLISHED" }, select: { divisionId: true } });
  for (const p of published) await setStatus(institutionId, year, p.divisionId, { status: "DRAFT", force: true }, actor);
  return { rebuild: [...rebuild], unpublished: published.map((p) => p.divisionId) };
}
