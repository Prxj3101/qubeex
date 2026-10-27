import type { AcademicYear } from "../../generated/prisma/client";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { resolveRequestedAcademicYear } from "../../utils/academicYear";
import {
  DAY_NAMES,
  type EngineEntry,
  type EngineRoom,
  type EngineSessionType,
  type EngineSlot,
  type Labels,
  type TeacherPref,
  resKey,
} from "./timetable.engine";
import type { Conflict } from "./timetable.engine";

/** "10" + "A" → "10-A", but "10" + "10-A" (division names that already carry the class) → "10-A", not "10-10-A". */
export const classLabel = (standardName: string, divisionName: string): string => {
    const num = standardName.replace(/^class\s*/i, '').trim() || standardName;
    const d = divisionName.trim();
    const low = d.toLowerCase();
    if (low.startsWith(`${num.toLowerCase()}-`) || low.startsWith(`${standardName.toLowerCase()}-`)) return d;
    return `${num}-${d}`;
};

export const httpError = (status: number, message: string) => ({ status, message });

/** Thrown when a proposed change would create hard conflicts. The route layer answers 409 + conflicts. */
export class TimetableConflictError extends Error {
  public readonly status = 409;
  constructor(message: string, public readonly conflicts: Conflict[]) {
    super(message);
  }
}

export async function resolveYear(
  academicYearId: string | undefined,
  institutionId: string,
  auth: { role: string; userId: string }
): Promise<AcademicYear> {
  return resolveRequestedAcademicYear(academicYearId, institutionId, auth);
}

/** Closed years are history: read-only. Active years (current or upcoming) are editable. */
export function assertWritable(year: AcademicYear): void {
  if (year.status !== "ACTIVE") {
    throw httpError(409, `Academic year ${year.label} is closed — its timetable is read-only.`);
  }
}

// Seeded once per institution on first use. These are ordinary editable rows — admins can rename,
// change or delete them and add their own custom types; nothing in the code depends on the names.
const DEFAULT_SESSION_TYPES: Array<Omit<Parameters<ReturnType<typeof academicDb>["timetableSessionType"]["create"]>[0]["data"], "institutionId">> = [
  { name: "Theory", kind: "THEORY", requiresTeacher: true, requiresRoom: false, defaultSpan: 1, color: "#3b82f6" },
  { name: "Practical", kind: "PRACTICAL", requiresTeacher: true, requiresRoom: true, roomType: "LAB", defaultSpan: 2, color: "#8b5cf6" },
  { name: "Lab Session", kind: "LAB", requiresTeacher: true, requiresRoom: true, roomType: "LAB", defaultSpan: 1, color: "#a855f7" },
  { name: "Activity", kind: "ACTIVITY", requiresTeacher: true, requiresRoom: false, defaultSpan: 1, color: "#f59e0b" },
  { name: "PT / Sports", kind: "PE_SPORTS", requiresTeacher: true, requiresRoom: true, roomType: "GROUND", defaultSpan: 1, color: "#10b981" },
  { name: "Library", kind: "LIBRARY", requiresTeacher: true, requiresRoom: true, roomType: "LIBRARY", defaultSpan: 1, color: "#14b8a6" },
  { name: "Class Teacher Period", kind: "CLASS_TEACHER", requiresTeacher: true, requiresRoom: false, defaultSpan: 1, color: "#ec4899" },
  { name: "Assembly", kind: "ASSEMBLY", requiresTeacher: false, requiresRoom: false, defaultSpan: 1, color: "#64748b" },
  { name: "Break", kind: "BREAK", requiresTeacher: false, requiresRoom: false, defaultSpan: 1, color: "#94a3b8" },
  { name: "Lunch", kind: "LUNCH", requiresTeacher: false, requiresRoom: false, defaultSpan: 1, color: "#94a3b8" },
  { name: "Free / Study", kind: "FREE", requiresTeacher: false, requiresRoom: false, defaultSpan: 1, color: "#cbd5e1" },
  { name: "Exam", kind: "EXAM", requiresTeacher: false, requiresRoom: false, defaultSpan: 1, color: "#ef4444" },
];

export async function ensureSessionTypes(institutionId: string) {
  const db = academicDb();
  const count = await db.timetableSessionType.count({ where: { institutionId } });
  if (count === 0) {
    await db.timetableSessionType.createMany({
      data: DEFAULT_SESSION_TYPES.map((t) => ({ ...t, institutionId })),
      skipDuplicates: true,
    });
  }
  return db.timetableSessionType.findMany({ where: { institutionId }, orderBy: { createdAt: "asc" } });
}

export interface TeacherInfo { id: string; name: string; userId: string }

export async function loadTeachers(institutionId: string): Promise<TeacherInfo[]> {
  const db = academicDb();
  const rows = await db.teacher.findMany({
    where: { institutionId, status: "ACTIVE" },
    select: { id: true, userId: true, prefix: true },
    orderBy: { createdAt: "asc" },
  });
  const users = await resolveUsers(rows.map((r) => r.userId), { id: true, name: true });
  return rows
    .map((r) => {
      const base = users.get(r.userId)?.name ?? "Teacher";
      return { id: r.id, userId: r.userId, name: r.prefix ? `${r.prefix} ${base}` : base };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface YearContext {
  year: AcademicYear;
  workingDays: number[];
  slots: EngineSlot[];
  sessionTypes: Map<string, EngineSessionType & { color: string | null; defaultSpan: number; isActive: boolean }>;
  rooms: Map<string, EngineRoom & { capacity: number | null }>;
  teacherUnavailable: Set<string>;
  teacherPreferred: Set<string>;
  roomUnavailable: Set<string>;
  teacherPrefs: Map<string, TeacherPref>;
  teachers: TeacherInfo[];
  divisions: Map<string, { id: string; name: string; standardId: string; standardName: string }>;
  labels: Labels;
}

export async function loadYearContext(institutionId: string, year: AcademicYear): Promise<YearContext> {
  const db = academicDb();
  const where = { institutionId, academicYearId: year.id };
  const [settings, slots, types, rooms, tAvail, rUnavail, prefs, teachers, divisions] = await Promise.all([
    db.timetableSettings.findUnique({ where: { institutionId_academicYearId: { institutionId, academicYearId: year.id } } }),
    db.timeSlot.findMany({ where, orderBy: { order: "asc" } }),
    ensureSessionTypes(institutionId),
    db.room.findMany({ where: { institutionId }, orderBy: { name: "asc" } }),
    db.teacherAvailability.findMany({ where }),
    db.roomUnavailability.findMany({ where }),
    db.teacherTimetablePref.findMany({ where }),
    loadTeachers(institutionId),
    db.division.findMany({ where: { institutionId }, select: { id: true, name: true, standardId: true, standard: { select: { name: true, order: true } } } }),
  ]);

  const teacherName = new Map(teachers.map((t) => [t.id, t.name]));
  const roomName = new Map(rooms.map((r) => [r.id, r.name]));
  const divMap = new Map(
    divisions.map((d) => [d.id, { id: d.id, name: d.name, standardId: d.standardId, standardName: d.standard.name }])
  );
  const slotName = new Map(slots.map((s) => [s.id, s.name]));

  const teacherUnavailable = new Set<string>();
  const teacherPreferred = new Set<string>();
  for (const a of tAvail) {
    (a.kind === "UNAVAILABLE" ? teacherUnavailable : teacherPreferred).add(resKey(a.teacherId, a.dayOfWeek, a.slotId));
  }
  const roomUnavailable = new Set(rUnavail.map((r) => resKey(r.roomId, r.dayOfWeek, r.slotId)));

  return {
    year,
    workingDays: [...(settings?.workingDays ?? [])].sort((a, b) => a - b),
    slots: slots.map((s) => ({ id: s.id, name: s.name, order: s.order, startMinute: s.startMinute, endMinute: s.endMinute, kind: s.kind })),
    sessionTypes: new Map(types.map((t) => [t.id, {
      id: t.id, name: t.name, kind: t.kind, requiresTeacher: t.requiresTeacher, requiresRoom: t.requiresRoom,
      roomType: t.roomType, color: t.color, defaultSpan: t.defaultSpan, isActive: t.isActive,
    }])),
    rooms: new Map(rooms.map((r) => [r.id, { id: r.id, name: r.name, type: r.type, isActive: r.isActive, capacity: r.capacity }])),
    teacherUnavailable, teacherPreferred, roomUnavailable,
    teacherPrefs: new Map(prefs.map((p) => [p.teacherId, {
      maxPeriodsPerDay: p.maxPeriodsPerDay, maxConsecutive: p.maxConsecutive, maxPeriodsPerWeek: p.maxPeriodsPerWeek,
    }])),
    teachers,
    divisions: divMap,
    labels: {
      teacher: (id) => teacherName.get(id) ?? "Unknown teacher",
      room: (id) => roomName.get(id) ?? "Unknown room",
      division: (id) => {
        const d = divMap.get(id);
        return d ? classLabel(d.standardName, d.name) : "Unknown class";
      },
      slot: (id) => slotName.get(id) ?? "?",
      day: (d) => DAY_NAMES[d] ?? String(d),
    },
  };
}

export const toEngineEntry = (e: {
  id: string; divisionId: string; dayOfWeek: number; slotId: string; sessionTypeId: string; subjectId: string | null;
  teacherId: string | null; roomId: string | null; configId: string | null; groupId: string | null; isLocked: boolean;
}): EngineEntry => ({
  id: e.id, divisionId: e.divisionId, dayOfWeek: e.dayOfWeek, slotId: e.slotId, sessionTypeId: e.sessionTypeId,
  subjectId: e.subjectId, teacherId: e.teacherId, roomId: e.roomId, configId: e.configId, groupId: e.groupId, isLocked: e.isLocked,
}) satisfies EngineEntry;

export async function loadYearEntries(institutionId: string, academicYearId: string): Promise<EngineEntry[]> {
  const rows = await academicDb().timetableEntry.findMany({
    where: { institutionId, academicYearId },
    select: {
      id: true, divisionId: true, dayOfWeek: true, slotId: true, sessionTypeId: true, subjectId: true,
      teacherId: true, roomId: true, configId: true, groupId: true, isLocked: true,
    },
  });
  return rows.map(toEngineEntry);
}

// ── dates ─────────────────────────────────────────────────────────────────────
/** True when a period is held in a lab (Science lab, Computer lab...), shown with a small flask icon. */
export const roomIsLab = (ctx: { rooms: Map<string, { type: string }> }, roomId: string | null | undefined): boolean =>
  !!roomId && (ctx.rooms.get(roomId)?.type ?? "").toUpperCase().includes("LAB");

export const parseDateOnly = (s: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw httpError(400, "Invalid date (expected YYYY-MM-DD)");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) throw httpError(400, "Invalid date");
  return d;
};
export const formatDateOnly = (d: Date): string => d.toISOString().slice(0, 10);
/** 1=Mon … 7=Sun for a UTC date-only value. */
export const dowOf = (d: Date): number => ((d.getUTCDay() + 6) % 7) + 1;
export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86400000);
export const weekStartOf = (d: Date): Date => addDays(d, -(dowOf(d) - 1));
export const todayUtc = (): Date => {
  const n = new Date();
  // India-first product: derive "today" in IST so the date flips at local midnight.
  const ist = new Date(n.getTime() + 330 * 60000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
};
export const istMinutesNow = (): number => {
  const ist = new Date(Date.now() + 330 * 60000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
};
