import type { AcademicYear } from "../../generated/prisma/client";
import { academicDb } from "../../utils/academicContext";
import {
  addDays, formatDateOnly, httpError, istMinutesNow, loadYearContext, parseDateOnly, todayUtc, weekStartOf, type YearContext,
} from "./timetable.common";
import { decorateEntries } from "./timetable.studio.service";

export type SessionStatus = "NORMAL" | "CANCELLED" | "CHANGED" | "SUBSTITUTED" | "COVERING" | "REASSIGNED";

export interface WeekSession {
  date: string;
  dayOfWeek: number;
  slotId: string;
  slotName: string;
  startMinute: number;
  endMinute: number;
  divisionId: string;
  divisionName: string;
  sessionTypeName: string;
  sessionKind: string;
  color: string | null;
  subjectName: string | null;
  title: string | null;
  teacherId: string | null;
  teacherName: string | null;
  roomName: string | null;
  status: SessionStatus;
  note: string | null;
  originalTeacherName: string | null;
  originalSubjectName: string | null;
}

type Filter = { divisionIds: string[] } | { teacherId: string };

/**
 * Resolve the effective (date-specific) timetable for one week from the PUBLISHED permanent timetable,
 * applying date exceptions and substitutions. The permanent rows are never modified.
 */
async function buildWeek(institutionId: string, year: AcademicYear, ctx: YearContext, weekStart: Date, filter: Filter) {
  const db = academicDb();
  const weekEnd = addDays(weekStart, 6);
  const published = { institutionId, academicYearId: year.id, timetable: { status: "PUBLISHED" as const } };

  let divisionIds: string[];
  if ("divisionIds" in filter) {
    divisionIds = filter.divisionIds;
  } else {
    const [mine, subs, excs] = await Promise.all([
      db.timetableEntry.findMany({ where: { ...published, teacherId: filter.teacherId }, select: { divisionId: true } }),
      db.timetableSubstitution.findMany({
        where: { institutionId, academicYearId: year.id, substituteTeacherId: filter.teacherId, date: { gte: weekStart, lte: weekEnd } },
        select: { entry: { select: { divisionId: true } } },
      }),
      db.timetableException.findMany({
        where: { institutionId, academicYearId: year.id, teacherId: filter.teacherId, date: { gte: weekStart, lte: weekEnd } },
        select: { divisionId: true },
      }),
    ]);
    divisionIds = [...new Set([...mine.map((m) => m.divisionId), ...subs.map((s) => s.entry.divisionId), ...excs.map((e) => e.divisionId)])];
  }
  if (!divisionIds.length) return { sessions: [] as WeekSession[], hasPublished: false };

  const [entries, excs, subs] = await Promise.all([
    db.timetableEntry.findMany({
      where: { ...published, divisionId: { in: divisionIds } },
      include: { subject: { select: { name: true, color: true } } },
    }),
    db.timetableException.findMany({
      where: { institutionId, academicYearId: year.id, divisionId: { in: divisionIds }, date: { gte: weekStart, lte: weekEnd } },
      include: { subject: { select: { name: true, color: true } } },
    }),
    db.timetableSubstitution.findMany({
      where: { institutionId, academicYearId: year.id, date: { gte: weekStart, lte: weekEnd }, entry: { divisionId: { in: divisionIds } } },
    }),
  ]);

  const slotById = new Map(ctx.slots.map((s) => [s.id, s]));
  const excKey = (div: string, date: string, slot: string) => `${div}|${date}|${slot}`;
  const excBy = new Map(excs.map((e) => [excKey(e.divisionId, formatDateOnly(e.date), e.slotId), e]));
  const subBy = new Map(subs.map((s) => [`${s.entryId}|${formatDateOnly(s.date)}`, s]));
  const baseBy = new Map(entries.map((e) => [`${e.divisionId}|${e.dayOfWeek}|${e.slotId}`, e]));

  const out: WeekSession[] = [];
  const push = (s: Omit<WeekSession, "slotName" | "startMinute" | "endMinute" | "divisionName" | "sessionTypeName" | "sessionKind" | "teacherName">
    & { sessionTypeId: string | null }) => {
    const slot = slotById.get(s.slotId);
    if (!slot) return;
    const st = s.sessionTypeId ? ctx.sessionTypes.get(s.sessionTypeId) : undefined;
    const { sessionTypeId, ...rest } = s;
    void sessionTypeId;
    out.push({
      ...rest, slotName: slot.name, startMinute: slot.startMinute, endMinute: slot.endMinute,
      divisionName: ctx.labels.division(s.divisionId), sessionTypeName: st?.name ?? "", sessionKind: st?.kind ?? "CUSTOM",
      teacherName: s.teacherId ? ctx.labels.teacher(s.teacherId) : null, color: s.color ?? st?.color ?? null,
    });
  };

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const ds = formatDateOnly(date);
    const dow = i + 1;
    // Permanent entries for this weekday, with exceptions / substitutions applied.
    for (const e of entries.filter((x) => x.dayOfWeek === dow)) {
      const exc = excBy.get(excKey(e.divisionId, ds, e.slotId));
      const sub = subBy.get(`${e.id}|${ds}`);
      const common = { date: ds, dayOfWeek: dow, slotId: e.slotId, divisionId: e.divisionId };
      if (exc?.kind === "CANCEL") {
        push({ ...common, sessionTypeId: e.sessionTypeId, color: e.subject?.color ?? null, subjectName: e.subject?.name ?? null, title: e.title, teacherId: e.teacherId, roomName: null, status: "CANCELLED", note: exc.reason, originalTeacherName: null, originalSubjectName: null });
      } else if (exc) {
        push({
          ...common, sessionTypeId: exc.sessionTypeId ?? e.sessionTypeId, color: exc.subject?.color ?? null, subjectName: exc.subject?.name ?? null,
          title: exc.title, teacherId: exc.teacherId, roomName: exc.roomId ? ctx.labels.room(exc.roomId) : null, status: "CHANGED", note: exc.reason,
          originalTeacherName: e.teacherId ? ctx.labels.teacher(e.teacherId) : null, originalSubjectName: e.subject?.name ?? e.title,
        });
      } else if (sub) {
        push({
          ...common, sessionTypeId: e.sessionTypeId, color: e.subject?.color ?? null, subjectName: e.subject?.name ?? null, title: e.title,
          teacherId: sub.substituteTeacherId, roomName: e.roomId ? ctx.labels.room(e.roomId) : null, status: "SUBSTITUTED", note: sub.reason,
          originalTeacherName: e.teacherId ? ctx.labels.teacher(e.teacherId) : null, originalSubjectName: null,
        });
      } else {
        push({ ...common, sessionTypeId: e.sessionTypeId, color: e.subject?.color ?? null, subjectName: e.subject?.name ?? null, title: e.title, teacherId: e.teacherId, roomName: e.roomId ? ctx.labels.room(e.roomId) : null, status: "NORMAL", note: null, originalTeacherName: null, originalSubjectName: null });
      }
    }
    // Overrides on a slot that has no permanent entry (e.g. a special event in a free period).
    for (const exc of excs.filter((x) => formatDateOnly(x.date) === ds && x.kind === "OVERRIDE")) {
      if (baseBy.has(`${exc.divisionId}|${dow}|${exc.slotId}`)) continue;
      push({
        date: ds, dayOfWeek: dow, slotId: exc.slotId, divisionId: exc.divisionId, sessionTypeId: exc.sessionTypeId, color: exc.subject?.color ?? null,
        subjectName: exc.subject?.name ?? null, title: exc.title, teacherId: exc.teacherId, roomName: exc.roomId ? ctx.labels.room(exc.roomId) : null,
        status: "CHANGED", note: exc.reason, originalTeacherName: null, originalSubjectName: null,
      });
    }
  }

  let sessions = out;
  if ("teacherId" in filter) {
    const me = filter.teacherId;
    // Keep what concerns this teacher: their own sessions, sessions handed away, and cover duty.
    const baseTeacher = (s: WeekSession) => baseBy.get(`${s.divisionId}|${s.dayOfWeek}|${s.slotId}`)?.teacherId ?? null;
    sessions = [];
    for (const s of out) {
      if (s.status === "SUBSTITUTED") {
        if (s.teacherId === me) sessions.push({ ...s, status: "COVERING" });
        else if (baseTeacher(s) === me) sessions.push(s);
      } else if (s.status === "CANCELLED") {
        if (s.teacherId === me) sessions.push(s);
      } else if (s.status === "CHANGED") {
        if (s.teacherId === me) sessions.push(s);
        else if (baseTeacher(s) === me) sessions.push({ ...s, status: "REASSIGNED" });
      } else if (s.teacherId === me) sessions.push(s);
    }
  }
  sessions.sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute);
  return { sessions, hasPublished: entries.length > 0 };
}

function shape(year: AcademicYear, ctx: YearContext, weekStart: Date, built: { sessions: WeekSession[]; hasPublished: boolean }) {
  const today = todayUtc();
  const todayStr = formatDateOnly(today);
  const nowMin = istMinutesNow();
  const todays = built.sessions.filter((s) => s.date === todayStr && s.status !== "CANCELLED" && s.status !== "REASSIGNED");
  const isTeachingKind = (k: string) => !["BREAK", "LUNCH"].includes(k);
  const live = todays.filter((s) => isTeachingKind(s.sessionKind));
  const current = live.find((s) => s.startMinute <= nowMin && nowMin < s.endMinute) ?? null;
  const next = live.find((s) => s.startMinute > nowMin) ?? null;
  return {
    published: built.hasPublished,
    academicYear: { id: year.id, label: year.label, isCurrent: year.isCurrent, status: year.status },
    weekStart: formatDateOnly(weekStart),
    today: todayStr,
    workingDays: ctx.workingDays,
    slots: ctx.slots,
    days: Array.from({ length: 7 }, (_, i) => {
      const date = formatDateOnly(addDays(weekStart, i));
      return { date, dayOfWeek: i + 1, isWorkingDay: ctx.workingDays.includes(i + 1), sessions: built.sessions.filter((s) => s.date === date) };
    }).filter((d) => d.isWorkingDay || d.sessions.length),
    current: year.isCurrent ? current : null,
    next: year.isCurrent ? next : null,
  };
}

const anchor = (dateStr?: string) => weekStartOf(dateStr ? parseDateOnly(dateStr) : todayUtc());

/** Teacher's own published schedule. Only ever returns the authenticated teacher's sessions. */
export async function teacherWeek(institutionId: string, year: AcademicYear, userId: string, dateStr?: string) {
  const teacher = await academicDb().teacher.findFirst({ where: { userId, institutionId }, select: { id: true } });
  if (!teacher) throw httpError(404, "Teacher profile not found");
  const ctx = await loadYearContext(institutionId, year);
  const weekStart = anchor(dateStr);
  return shape(year, ctx, weekStart, await buildWeek(institutionId, year, ctx, weekStart, { teacherId: teacher.id }));
}

/**
 * Student's own class timetable. The class comes from the student's enrollment for the
 * requested year — never from request input — so another section cannot be requested.
 */
export async function studentWeek(institutionId: string, year: AcademicYear, userId: string, dateStr?: string) {
  const db = academicDb();
  const student = await db.student.findFirst({ where: { userId, institutionId }, select: { id: true, divisionId: true } });
  if (!student) throw httpError(404, "Student profile not found");
  const enrollment = await db.studentEnrollment.findFirst({
    where: { studentId: student.id, academicYearId: year.id, institutionId },
    select: { divisionId: true },
  });
  // Same rule as the rest of the student app: for the CURRENT year the student's live division is the
  // truth (older students may have no enrollment row yet); other years need that year's enrollment.
  const divisionId = enrollment?.divisionId ?? (year.isCurrent ? student.divisionId : null);
  if (!divisionId) {
    throw httpError(403, year.isCurrent ? "You are not assigned to a class yet" : "No enrollment found for this academic year");
  }
  const ctx = await loadYearContext(institutionId, year);
  const weekStart = anchor(dateStr);
  const built = await buildWeek(institutionId, year, ctx, weekStart, { divisionIds: [divisionId] });
  return { ...shape(year, ctx, weekStart, built), division: ctx.labels.division(divisionId) };
}

/**
 * Published weekly timetable of one class, for a teacher assigned to it (access is checked by the route
 * with assertAcademicYearAccess). Same overlay rules as the student view.
 */
export async function divisionWeek(institutionId: string, year: AcademicYear, divisionId: string, dateStr?: string) {
  const division = await academicDb().division.findFirst({ where: { id: divisionId, institutionId }, select: { id: true } });
  if (!division) throw httpError(404, "Class/section not found");
  const ctx = await loadYearContext(institutionId, year);
  const weekStart = anchor(dateStr);
  const built = await buildWeek(institutionId, year, ctx, weekStart, { divisionIds: [divisionId] });
  return { ...shape(year, ctx, weekStart, built), division: ctx.labels.division(divisionId) };
}

// ── Admin cross-views ──────────────────────────────────────────────────────────
export type ViewKind = "teacher" | "room" | "subject" | "master";

export async function adminView(institutionId: string, year: AcademicYear, kind: ViewKind, id: string | undefined, standardId?: string) {
  const db = academicDb();
  const ctx = await loadYearContext(institutionId, year);
  let where: Record<string, unknown> = { institutionId, academicYearId: year.id };
  let title = "Master timetable";
  if (kind === "teacher") {
    if (!id) throw httpError(400, "teacherId required");
    if (!ctx.teachers.some((t) => t.id === id)) throw httpError(404, "Teacher not found");
    where = { ...where, teacherId: id };
    title = ctx.labels.teacher(id);
  } else if (kind === "room") {
    if (!id) throw httpError(400, "roomId required");
    if (!ctx.rooms.has(id)) throw httpError(404, "Room not found");
    where = { ...where, roomId: id };
    title = ctx.labels.room(id);
  } else if (kind === "subject") {
    if (!id) throw httpError(400, "subjectId required");
    const subject = await db.subject.findFirst({ where: { id, institutionId }, select: { name: true } });
    if (!subject) throw httpError(404, "Subject not found");
    // Aggregate the same-named subject across every class (Maths of 9, 10, …).
    const siblings = await db.subject.findMany({ where: { institutionId, name: { equals: subject.name, mode: "insensitive" } }, select: { id: true } });
    where = { ...where, subjectId: { in: siblings.map((x) => x.id) } };
    title = subject.name;
  } else if (standardId) {
    where = { ...where, division: { standardId } };
  }
  const rows = await db.timetableEntry.findMany({
    where,
    select: { id: true },
    take: 6000,
  });
  const entries = await decorateEntries(institutionId, rows.map((r) => r.id), ctx);
  const statuses = await db.schoolTimetable.findMany({ where: { institutionId, academicYearId: year.id }, select: { divisionId: true, status: true } });
  const statusBy = new Map(statuses.map((s) => [s.divisionId, s.status]));
  return {
    title, kind, workingDays: ctx.workingDays, slots: ctx.slots,
    entries: entries.map((e) => ({ ...e, divisionName: ctx.labels.division(e.divisionId), timetableStatus: statusBy.get(e.divisionId) ?? null })),
    summary: {
      totalPeriods: entries.length,
      perDay: ctx.workingDays.map((d) => ({ dayOfWeek: d, count: entries.filter((e) => e.dayOfWeek === d).length })),
      divisions: [...new Set(entries.map((e) => e.divisionId))].length,
    },
  };
}


