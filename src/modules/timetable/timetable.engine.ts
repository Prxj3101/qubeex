// Pure scheduling logic for the Timetable Studio: conflict detection + automatic generation.
// No database access here — the service layer loads data and passes plain objects in.

export type SlotKind = "PERIOD" | "BREAK" | "LUNCH" | "ASSEMBLY" | "ACTIVITY";

export interface EngineSlot {
  id: string;
  name: string;
  order: number;
  startMinute: number;
  endMinute: number;
  kind: SlotKind;
}

export interface EngineSessionType {
  id: string;
  name: string;
  kind: string;
  requiresTeacher: boolean;
  requiresRoom: boolean;
  roomType: string | null;
}

export interface EngineRoom {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
}

export interface EngineEntry {
  id: string;
  divisionId: string;
  dayOfWeek: number;
  slotId: string;
  sessionTypeId: string;
  subjectId: string | null;
  teacherId: string | null;
  roomId: string | null;
  configId: string | null;
  groupId: string | null;
  isLocked: boolean;
}

export interface EngineConfig {
  id: string;
  divisionId: string;
  subjectId: string | null;
  sessionTypeId: string;
  label: string;
  periodsPerWeek: number;
  span: number;
  maxPerDay: number;
  teacherId: string | null;
  roomId: string | null;
  roomType: string | null;
}

export interface TeacherPref {
  maxPeriodsPerDay: number | null;
  maxConsecutive: number | null;
  maxPeriodsPerWeek: number | null;
}

export interface Labels {
  teacher: (id: string) => string;
  room: (id: string) => string;
  division: (id: string) => string;
  slot: (id: string) => string;
  day: (d: number) => string;
}

export const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const cellKey = (day: number, slotId: string) => `${day}|${slotId}`;
export const resKey = (resId: string, day: number, slotId: string) => `${resId}|${day}|${slotId}`;

// ── Conflict detection ──────────────────────────────────────────────────────────

export type ConflictType =
  | "TEACHER_CLASH"
  | "ROOM_CLASH"
  | "TEACHER_UNAVAILABLE"
  | "ROOM_UNAVAILABLE"
  | "ROOM_INCOMPATIBLE"
  | "NON_TEACHING_SLOT"
  | "OUTSIDE_WORKING_DAY"
  | "PRACTICAL_NOT_CONSECUTIVE"
  | "MISSING_TEACHER"
  | "MISSING_ROOM"
  | "TEACHER_OVERLOAD"
  | "REQUIREMENT_SHORTFALL";

export interface Conflict {
  type: ConflictType;
  severity: "ERROR" | "WARNING";
  message: string;
  divisionId?: string;
  entryIds: string[];
  cells: { divisionId: string; dayOfWeek: number; slotId: string }[];
  teacherId?: string;
  roomId?: string;
  configId?: string;
}

export interface ConflictInput {
  entries: EngineEntry[];
  slots: EngineSlot[];
  workingDays: number[];
  sessionTypes: Map<string, EngineSessionType>;
  rooms: Map<string, EngineRoom>;
  teacherUnavailable: Set<string>; // resKey(teacherId, day, slotId)
  roomUnavailable: Set<string>; // resKey(roomId, day, slotId)
  teacherPrefs?: Map<string, TeacherPref>;
  configs?: EngineConfig[];
  labels: Labels;
}

const cellOf = (e: EngineEntry) => ({ divisionId: e.divisionId, dayOfWeek: e.dayOfWeek, slotId: e.slotId });

export function detectConflicts(input: ConflictInput): Conflict[] {
  const { entries, slots, workingDays, sessionTypes, rooms, teacherUnavailable, roomUnavailable, labels } = input;
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const out: Conflict[] = [];

  const byTeacherCell = new Map<string, EngineEntry[]>();
  const byRoomCell = new Map<string, EngineEntry[]>();

  for (const e of entries) {
    const st = sessionTypes.get(e.sessionTypeId);
    const slot = slotById.get(e.slotId);
    const where = `${labels.division(e.divisionId)} · ${labels.day(e.dayOfWeek)} ${slot?.name ?? ""}`.trim();

    if (e.teacherId) {
      const k = resKey(e.teacherId, e.dayOfWeek, e.slotId);
      (byTeacherCell.get(k) ?? byTeacherCell.set(k, []).get(k)!).push(e);
      if (teacherUnavailable.has(k)) {
        out.push({
          type: "TEACHER_UNAVAILABLE", severity: "ERROR", divisionId: e.divisionId, entryIds: [e.id], cells: [cellOf(e)],
          teacherId: e.teacherId,
          message: `${labels.teacher(e.teacherId)} is marked unavailable at ${where}.`,
        });
      }
    }
    if (e.roomId) {
      const k = resKey(e.roomId, e.dayOfWeek, e.slotId);
      (byRoomCell.get(k) ?? byRoomCell.set(k, []).get(k)!).push(e);
      if (roomUnavailable.has(k)) {
        out.push({
          type: "ROOM_UNAVAILABLE", severity: "ERROR", divisionId: e.divisionId, entryIds: [e.id], cells: [cellOf(e)],
          roomId: e.roomId,
          message: `${labels.room(e.roomId)} is unavailable at ${where}.`,
        });
      }
      const room = rooms.get(e.roomId);
      if (st?.roomType && room && room.type !== st.roomType) {
        out.push({
          type: "ROOM_INCOMPATIBLE", severity: "ERROR", divisionId: e.divisionId, entryIds: [e.id], cells: [cellOf(e)],
          roomId: e.roomId,
          message: `${st.name} needs a ${st.roomType} room but ${room.name} is a ${room.type} room (${where}).`,
        });
      }
    }
    if (st?.requiresTeacher && !e.teacherId && st.kind !== "FREE") {
      out.push({
        type: "MISSING_TEACHER", severity: "WARNING", divisionId: e.divisionId, entryIds: [e.id], cells: [cellOf(e)],
        message: `${st.name} at ${where} has no teacher assigned.`,
      });
    }
    if (st?.requiresRoom && !e.roomId) {
      out.push({
        type: "MISSING_ROOM", severity: "WARNING", divisionId: e.divisionId, entryIds: [e.id], cells: [cellOf(e)],
        message: `${st.name} at ${where} has no room assigned.`,
      });
    }
    if (slot && slot.kind !== "PERIOD" && st && !["ASSEMBLY", "BREAK", "LUNCH", "ACTIVITY", "EXAM"].includes(st.kind)) {
      out.push({
        type: "NON_TEACHING_SLOT", severity: "ERROR", divisionId: e.divisionId, entryIds: [e.id], cells: [cellOf(e)],
        message: `${st.name} is placed in the ${slot.kind.toLowerCase()} slot "${slot.name}" (${where}).`,
      });
    }
    if (!workingDays.includes(e.dayOfWeek)) {
      out.push({
        type: "OUTSIDE_WORKING_DAY", severity: "ERROR", divisionId: e.divisionId, entryIds: [e.id], cells: [cellOf(e)],
        message: `${labels.day(e.dayOfWeek)} is not a working day (${labels.division(e.divisionId)}).`,
      });
    }
  }

  for (const [k, list] of byTeacherCell) {
    if (list.length < 2) continue;
    const [teacherId, day, slotId] = k.split("|");
    const divs = list.map((e) => labels.division(e.divisionId)).join(" and ");
    out.push({
      type: "TEACHER_CLASH", severity: "ERROR", teacherId, entryIds: list.map((e) => e.id), cells: list.map(cellOf),
      message: `${labels.teacher(teacherId)} is assigned to ${divs} at ${labels.day(Number(day))} ${labels.slot(slotId)}.`,
    });
  }
  for (const [k, list] of byRoomCell) {
    if (list.length < 2) continue;
    const [roomId, day, slotId] = k.split("|");
    const divs = list.map((e) => labels.division(e.divisionId)).join(" and ");
    out.push({
      type: "ROOM_CLASH", severity: "ERROR", roomId, entryIds: list.map((e) => e.id), cells: list.map(cellOf),
      message: `${labels.room(roomId)} is assigned to ${divs} at ${labels.day(Number(day))} ${labels.slot(slotId)}.`,
    });
  }

  // Multi-period sessions (shared groupId) must sit on adjacent teaching slots of one day.
  const sortedPeriods = slots.filter((s) => s.kind === "PERIOD").sort((a, b) => a.order - b.order);
  const periodIdx = new Map(sortedPeriods.map((s, i) => [s.id, i]));
  const groups = new Map<string, EngineEntry[]>();
  for (const e of entries) if (e.groupId) (groups.get(e.groupId) ?? groups.set(e.groupId, []).get(e.groupId)!).push(e);
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const days = new Set(list.map((e) => e.dayOfWeek));
    const idxs = list.map((e) => periodIdx.get(e.slotId)).filter((x): x is number => x != null).sort((a, b) => a - b);
    const contiguous = idxs.length === list.length && idxs.every((v, i) => i === 0 || v === idxs[i - 1] + 1);
    // adjacent in period index but a break in between is impossible because breaks are not PERIOD slots —
    // however two PERIOD slots with a non-period slot between them are *not* consecutive in time.
    let brokenByBreak = false;
    if (contiguous) {
      for (let i = 1; i < idxs.length; i++) {
        const a = sortedPeriods[idxs[i - 1]];
        const b = sortedPeriods[idxs[i]];
        if (slots.some((s) => s.kind !== "PERIOD" && s.order > a.order && s.order < b.order)) brokenByBreak = true;
      }
    }
    if (days.size > 1 || !contiguous || brokenByBreak) {
      const e0 = list[0];
      const st = sessionTypes.get(e0.sessionTypeId);
      out.push({
        type: "PRACTICAL_NOT_CONSECUTIVE", severity: "ERROR", divisionId: e0.divisionId, entryIds: list.map((e) => e.id),
        cells: list.map(cellOf),
        message: `${st?.name ?? "Session"} for ${labels.division(e0.divisionId)} needs ${list.length} consecutive periods but they are not adjacent.`,
      });
    }
  }

  // Teacher workload limits (soft — reported as warnings).
  if (input.teacherPrefs) {
    const perDay = new Map<string, number>();
    const perWeek = new Map<string, number>();
    for (const e of entries) {
      if (!e.teacherId) continue;
      const dk = `${e.teacherId}|${e.dayOfWeek}`;
      perDay.set(dk, (perDay.get(dk) ?? 0) + 1);
      perWeek.set(e.teacherId, (perWeek.get(e.teacherId) ?? 0) + 1);
    }
    for (const [dk, n] of perDay) {
      const [tid, day] = dk.split("|");
      const max = input.teacherPrefs.get(tid)?.maxPeriodsPerDay;
      if (max != null && n > max) {
        out.push({
          type: "TEACHER_OVERLOAD", severity: "WARNING", teacherId: tid, entryIds: [], cells: [],
          message: `${labels.teacher(tid)} has ${n} periods on ${labels.day(Number(day))} (max ${max}).`,
        });
      }
    }
    for (const [tid, n] of perWeek) {
      const max = input.teacherPrefs.get(tid)?.maxPeriodsPerWeek;
      if (max != null && n > max) {
        out.push({
          type: "TEACHER_OVERLOAD", severity: "WARNING", teacherId: tid, entryIds: [], cells: [],
          message: `${labels.teacher(tid)} has ${n} periods this week (max ${max}).`,
        });
      }
    }
  }

  // Weekly requirement shortfalls.
  if (input.configs) {
    const counts = new Map<string, number>();
    for (const e of entries) if (e.configId) counts.set(e.configId, (counts.get(e.configId) ?? 0) + 1);
    for (const c of input.configs) {
      const have = counts.get(c.id) ?? 0;
      if (have < c.periodsPerWeek) {
        out.push({
          type: "REQUIREMENT_SHORTFALL", severity: "WARNING", divisionId: c.divisionId, configId: c.id, entryIds: [], cells: [],
          message: `${c.label} is scheduled ${have} of ${c.periodsPerWeek} required periods per week.`,
        });
      }
    }
  }

  return out;
}

export interface RequirementStatus {
  configId: string;
  label: string;
  required: number;
  scheduled: number;
  status: "COMPLETE" | "INCOMPLETE" | "EXCEEDED";
}

export function requirementStatus(configs: EngineConfig[], entries: EngineEntry[]): RequirementStatus[] {
  const counts = new Map<string, number>();
  for (const e of entries) if (e.configId) counts.set(e.configId, (counts.get(e.configId) ?? 0) + 1);
  return configs.map((c) => {
    const scheduled = counts.get(c.id) ?? 0;
    return {
      configId: c.id,
      label: c.label,
      required: c.periodsPerWeek,
      scheduled,
      status: scheduled === c.periodsPerWeek ? "COMPLETE" : scheduled < c.periodsPerWeek ? "INCOMPLETE" : "EXCEEDED",
    };
  });
}

/**
 * Validate a *proposed* set of changes. Returns only the ERROR-level conflicts that involve
 * the touched entries so the caller can warn the admin without drowning them in unrelated issues.
 */
export function conflictsForEntries(all: Conflict[], entryIds: string[]): Conflict[] {
  const ids = new Set(entryIds);
  return all.filter((c) => c.severity === "ERROR" && c.entryIds.some((id) => ids.has(id)));
}

// ── Generator ───────────────────────────────────────────────────────────────────

export interface GeneratorInput {
  divisionId: string;
  slots: EngineSlot[];
  workingDays: number[];
  configs: EngineConfig[]; // only this division's configs (teacherId already resolved)
  sessionTypes: Map<string, EngineSessionType>;
  rooms: EngineRoom[];
  /** Entries to keep untouched (this division's locked entries). */
  lockedEntries: EngineEntry[];
  /** Entries of OTHER divisions in the same year: used for teacher/room occupancy. */
  otherEntries: EngineEntry[];
  teacherUnavailable: Set<string>;
  teacherPreferred: Set<string>;
  roomUnavailable: Set<string>;
  teacherPrefs: Map<string, TeacherPref>;
  labels: Labels;
  timeLimitMs?: number;
  maxNodes?: number;
  /** Different seeds → different (equally valid) arrangements. Omitted → fully deterministic. */
  seed?: number;
  /**
   * Other sections whose UNLOCKED sessions may be moved to make room for periods that would otherwise stay
   * unplaced. Pass only sections that are not published/archived. Omitted → other sections are fixed.
   */
  movable?: { divisionIds: Set<string>; configs: EngineConfig[] };
}

/** A whole session (one period, or a consecutive block) of another section that was moved to make room. */
export interface SessionMove {
  divisionId: string;
  configId: string | null;
  entryIds: string[];          // ordered by period
  fromDay: number;
  fromSlotIds: string[];
  toDay: number;
  toSlotIds: string[];
  toRoomId: string | null;
}

export interface Placement {
  configId: string;
  dayOfWeek: number;
  slotIds: string[]; // consecutive teaching slots, length = block size
  teacherId: string | null;
  roomId: string | null;
}

export interface GeneratorResult {
  placements: Placement[];
  complete: boolean;
  placed: number;
  unplaced: number;
  problems: string[];
  timedOut: boolean;
  /** Sessions of other sections moved to make room (empty unless `movable` was given and needed). */
  moves: SessionMove[];
}

interface Block {
  config: EngineConfig;
  size: number;
  index: number;
  rootCandidates: number;
}

interface Candidate {
  day: number;
  runStart: number; // index into teachingPeriods
  roomId: string | null;
}

/** Stable pseudo-random number in [0,1) from a string + seed (so a given seed always gives the same result). */
function seededUnit(key: string, seed: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function generateTimetable(input: GeneratorInput): GeneratorResult {
  const started = Date.now();
  const timeLimit = input.timeLimitMs ?? 3000;
  const maxNodes = input.maxNodes ?? 300000;
  const { labels } = input;

  const teaching = input.slots.filter((s) => s.kind === "PERIOD").sort((a, b) => a.order - b.order);
  // runId increments whenever a non-teaching slot sits between two periods: blocks may not span runs.
  const runOf: number[] = [];
  {
    let run = 0;
    teaching.forEach((s, i) => {
      if (i > 0) {
        const prev = teaching[i - 1];
        if (input.slots.some((x) => x.kind !== "PERIOD" && x.order > prev.order && x.order < s.order)) run++;
      }
      runOf.push(run);
    });
  }
  const days = [...input.workingDays].sort((a, b) => a - b);

  // Occupancy from other divisions + our own locked entries.
  const teacherBusy = new Set<string>();
  const roomBusy = new Set<string>();
  for (const e of input.otherEntries) {
    if (e.teacherId) teacherBusy.add(resKey(e.teacherId, e.dayOfWeek, e.slotId));
    if (e.roomId) roomBusy.add(resKey(e.roomId, e.dayOfWeek, e.slotId));
  }
  const divisionBusy = new Set<string>();
  const teacherDay = new Map<string, number>(); // teacherId|day → count
  const teacherWeek = new Map<string, number>();
  const subjectDay = new Map<string, number>(); // configId|day → count
  const dayLoad = new Map<number, number>();
  const placedPerConfig = new Map<string, number>();
  const cellConfig = new Map<string, string>(); // cellKey → configId, to keep the same subject out of adjacent periods

  const note = (teacherId: string | null, day: number, delta: number) => {
    if (!teacherId) return;
    const dk = `${teacherId}|${day}`;
    teacherDay.set(dk, (teacherDay.get(dk) ?? 0) + delta);
    teacherWeek.set(teacherId, (teacherWeek.get(teacherId) ?? 0) + delta);
  };

  for (const e of input.otherEntries) note(e.teacherId, e.dayOfWeek, 1);
  for (const e of input.lockedEntries) {
    divisionBusy.add(cellKey(e.dayOfWeek, e.slotId));
    if (e.configId) cellConfig.set(cellKey(e.dayOfWeek, e.slotId), e.configId);
    if (e.teacherId) {
      teacherBusy.add(resKey(e.teacherId, e.dayOfWeek, e.slotId));
      note(e.teacherId, e.dayOfWeek, 1);
    }
    if (e.roomId) roomBusy.add(resKey(e.roomId, e.dayOfWeek, e.slotId));
    if (e.configId) {
      placedPerConfig.set(e.configId, (placedPerConfig.get(e.configId) ?? 0) + 1);
      subjectDay.set(`${e.configId}|${e.dayOfWeek}`, (subjectDay.get(`${e.configId}|${e.dayOfWeek}`) ?? 0) + 1);
    }
    dayLoad.set(e.dayOfWeek, (dayLoad.get(e.dayOfWeek) ?? 0) + 1);
  }

  // Break configs into blocks of `span` consecutive periods (remainder becomes a smaller block).
  const problems: string[] = [];
  const blocks: Block[] = [];
  for (const c of input.configs) {
    const remaining = c.periodsPerWeek - (placedPerConfig.get(c.id) ?? 0);
    if (remaining <= 0) continue;
    const span = Math.max(1, c.span);
    let left = remaining;
    let idx = 0;
    while (left > 0) {
      const size = Math.min(span, left);
      blocks.push({ config: c, size, index: idx++, rootCandidates: 0 });
      left -= size;
    }
  }

  const roomsByType = new Map<string, EngineRoom[]>();
  for (const r of input.rooms) {
    if (!r.isActive) continue;
    (roomsByType.get(r.type) ?? roomsByType.set(r.type, []).get(r.type)!).push(r);
  }

  const roomOptions = (c: EngineConfig): (string | null)[] | "NONE_AVAILABLE" => {
    const st = input.sessionTypes.get(c.sessionTypeId);
    if (c.roomId) return [c.roomId];
    const type = c.roomType ?? st?.roomType ?? null;
    if (type) {
      const list = roomsByType.get(type) ?? [];
      return list.length ? list.map((r) => r.id) : "NONE_AVAILABLE";
    }
    if (st?.requiresRoom) return "NONE_AVAILABLE";
    return [null];
  };

  const requiresTeacher = (c: EngineConfig) => input.sessionTypes.get(c.sessionTypeId)?.requiresTeacher ?? true;

  // Reasons a candidate cell failed (used for diagnostics).
  type Reason = "DIVISION_BUSY" | "TEACHER_UNAVAILABLE" | "TEACHER_BUSY" | "TEACHER_LIMIT" | "ROOM_UNAVAILABLE" | "ROOM_BUSY";

  /** Does this block touch a period already holding the same requirement (back-to-back)? Single-period blocks only. */
  const touchesSame = (c: EngineConfig, size: number, day: number, start: number): boolean => {
    const neighbours = [start - 1, start + size];
    return neighbours.some((i) => i >= 0 && i < teaching.length && runOf[i] === runOf[start] && cellConfig.get(cellKey(day, teaching[i].id)) === c.id);
  };

  const checkCandidate = (
    c: EngineConfig,
    size: number,
    day: number,
    start: number,
    roomId: string | null,
    strictPerDay: boolean,
    reasons?: Map<string, number>
  ): boolean => {
    const bump = (r: Reason, extra = "") => {
      if (reasons) reasons.set(r + "|" + extra, (reasons.get(r + "|" + extra) ?? 0) + 1);
    };
    const pref = c.teacherId ? input.teacherPrefs.get(c.teacherId) : undefined;
    for (let k = 0; k < size; k++) {
      const slot = teaching[start + k];
      if (divisionBusy.has(cellKey(day, slot.id))) { bump("DIVISION_BUSY"); return false; }
      if (c.teacherId) {
        const rk = resKey(c.teacherId, day, slot.id);
        if (input.teacherUnavailable.has(rk)) { bump("TEACHER_UNAVAILABLE", `${day}|${slot.id}`); return false; }
        if (teacherBusy.has(rk)) { bump("TEACHER_BUSY", `${day}|${slot.id}`); return false; }
      }
      if (roomId) {
        const rk = resKey(roomId, day, slot.id);
        if (input.roomUnavailable.has(rk)) { bump("ROOM_UNAVAILABLE", `${day}|${slot.id}|${roomId}`); return false; }
        if (roomBusy.has(rk)) { bump("ROOM_BUSY", `${day}|${slot.id}|${roomId}`); return false; }
      }
    }
    if (c.teacherId && pref) {
      const day_n = teacherDay.get(`${c.teacherId}|${day}`) ?? 0;
      if (pref.maxPeriodsPerDay != null && day_n + size > pref.maxPeriodsPerDay) { bump("TEACHER_LIMIT", "day"); return false; }
      const wk = teacherWeek.get(c.teacherId) ?? 0;
      if (pref.maxPeriodsPerWeek != null && wk + size > pref.maxPeriodsPerWeek) { bump("TEACHER_LIMIT", "week"); return false; }
      if (pref.maxConsecutive != null) {
        // count the run of teacher-busy periods this block would join
        let before = 0;
        for (let i = start - 1; i >= 0 && runOf[i] === runOf[start]; i--) {
          if (teacherBusy.has(resKey(c.teacherId, day, teaching[i].id))) before++; else break;
        }
        let after = 0;
        for (let i = start + size; i < teaching.length && runOf[i] === runOf[start]; i++) {
          if (teacherBusy.has(resKey(c.teacherId, day, teaching[i].id))) after++; else break;
        }
        if (before + size + after > pref.maxConsecutive) { bump("TEACHER_LIMIT", "consecutive"); return false; }
      }
    }
    if (strictPerDay) {
      if (c.span <= 1 && touchesSame(c, size, day, start)) return false;
      const used = subjectDay.get(`${c.id}|${day}`) ?? 0;
      if (used + size > Math.max(c.maxPerDay, size)) return false;
    }
    return true;
  };

  const candidatesFor = (b: Block, strictPerDay: boolean): Candidate[] => {
    const c = b.config;
    const opts = roomOptions(c);
    if (opts === "NONE_AVAILABLE") return [];
    if (requiresTeacher(c) && !c.teacherId) return [];
    const list: Candidate[] = [];
    for (const day of days) {
      for (let start = 0; start + b.size <= teaching.length; start++) {
        if (runOf[start] !== runOf[start + b.size - 1]) continue;
        for (const roomId of opts) {
          if (checkCandidate(c, b.size, day, start, roomId, strictPerDay)) list.push({ day, runStart: start, roomId });
        }
      }
    }
    return list;
  };

  const score = (b: Block, cand: Candidate): number => {
    const c = b.config;
    let s = 0;
    const same = subjectDay.get(`${c.id}|${cand.day}`) ?? 0;
    s += same * 10;
    if (c.span <= 1 && touchesSame(c, b.size, cand.day, cand.runStart)) s += 25; // avoid back-to-back lectures of one subject
    s += (dayLoad.get(cand.day) ?? 0) * 0.8;
    const st = input.sessionTypes.get(c.sessionTypeId);
    // Core/theory early in the day, activity/sports later.
    if (st?.kind === "THEORY") s += cand.runStart * 0.3;
    if (st && ["ACTIVITY", "PE_SPORTS", "LIBRARY", "CLASS_TEACHER"].includes(st.kind)) s -= cand.runStart * 0.2;
    if (c.teacherId) {
      for (let k = 0; k < b.size; k++) {
        if (input.teacherPreferred.has(resKey(c.teacherId, cand.day, teaching[cand.runStart + k].id))) s -= 1.5;
      }
      // adjacent teacher periods build long consecutive runs
      const prev = cand.runStart - 1;
      const next = cand.runStart + b.size;
      if (prev >= 0 && runOf[prev] === runOf[cand.runStart] && teacherBusy.has(resKey(c.teacherId, cand.day, teaching[prev].id))) s += 2;
      if (next < teaching.length && runOf[next] === runOf[cand.runStart] && teacherBusy.has(resKey(c.teacherId, cand.day, teaching[next].id))) s += 2;
      s += (teacherDay.get(`${c.teacherId}|${cand.day}`) ?? 0) * 0.4;
    }
    if (input.seed != null) s += seededUnit(`${c.id}|${b.index}|${cand.day}|${cand.runStart}|${cand.roomId}`, input.seed) * 2.5;
    return s;
  };

  // Block ordering: biggest spans, then scarcest (fewest root candidates), deterministic tie-break.
  for (const b of blocks) b.rootCandidates = candidatesFor(b, false).length;
  const feasible = blocks.filter((b) => b.rootCandidates > 0);
  const infeasible = blocks.filter((b) => b.rootCandidates === 0);
  feasible.sort(
    (a, b) =>
      b.size - a.size ||
      a.rootCandidates - b.rootCandidates ||
      (input.seed != null
        ? seededUnit(`${a.config.id}|${a.index}`, input.seed) - seededUnit(`${b.config.id}|${b.index}`, input.seed)
        : a.config.id.localeCompare(b.config.id)) ||
      a.index - b.index
  );

  let best: Placement[] = [];
  let bestUnplaced = Number.POSITIVE_INFINITY;
  let nodes = 0;
  let timedOut = false;
  const stack: Placement[] = [];

  const apply = (b: Block, cand: Candidate, sign: 1 | -1) => {
    const c = b.config;
    for (let k = 0; k < b.size; k++) {
      const slot = teaching[cand.runStart + k];
      const ck = cellKey(cand.day, slot.id);
      if (sign === 1) { divisionBusy.add(ck); cellConfig.set(ck, c.id); } else { divisionBusy.delete(ck); cellConfig.delete(ck); }
      if (c.teacherId) {
        const rk = resKey(c.teacherId, cand.day, slot.id);
        if (sign === 1) teacherBusy.add(rk); else teacherBusy.delete(rk);
      }
      if (cand.roomId) {
        const rk = resKey(cand.roomId, cand.day, slot.id);
        if (sign === 1) roomBusy.add(rk); else roomBusy.delete(rk);
      }
    }
    note(c.teacherId, cand.day, sign * b.size);
    const sk = `${c.id}|${cand.day}`;
    subjectDay.set(sk, (subjectDay.get(sk) ?? 0) + sign * b.size);
    dayLoad.set(cand.day, (dayLoad.get(cand.day) ?? 0) + sign * b.size);
  };

  const search = (i: number, strict: boolean, deadline: number, nodeCap: number): boolean => {
    if (i === feasible.length) {
      best = stack.slice();
      bestUnplaced = 0;
      return true;
    }
    if (++nodes > nodeCap || Date.now() > deadline) {
      timedOut = true;
      return false;
    }
    const b = feasible[i];
    const cands = candidatesFor(b, strict)
      .map((c) => ({ c, s: score(b, c) }))
      .sort((x, y) => x.s - y.s || x.c.day - y.c.day || x.c.runStart - y.c.runStart);
    for (const { c: cand } of cands) {
      apply(b, cand, 1);
      stack.push({
        configId: b.config.id,
        dayOfWeek: cand.day,
        slotIds: Array.from({ length: b.size }, (_, k) => teaching[cand.runStart + k].id),
        teacherId: b.config.teacherId,
        roomId: cand.roomId,
      });
      if (search(i + 1, strict, deadline, nodeCap)) return true;
      stack.pop();
      apply(b, cand, -1);
      if (timedOut) break;
    }
    // Record the best partial solution reached (everything placed so far).
    const unplacedHere = feasible.length - stack.length;
    if (unplacedHere < bestUnplaced) {
      best = stack.slice();
      bestUnplaced = unplacedHere;
    }
    return false;
  };

  // Pass 1 honours each subject's max-per-day (soft rule) on a third of the budget; pass 2 relaxes it.
  let solved = search(0, true, started + Math.floor(timeLimit / 3), Math.floor(maxNodes / 3));
  if (!solved) {
    nodes = 0;
    timedOut = false;
    stack.length = 0;
    best = [];
    bestUnplaced = Number.POSITIVE_INFINITY;
    solved = search(0, false, started + timeLimit, maxNodes);
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────
  // Rebuild occupancy from `best` so reasons reflect what actually blocked the leftovers.
  const rebuild = () => {
    for (const p of best) {
      for (const sid of p.slotIds) {
        divisionBusy.add(cellKey(p.dayOfWeek, sid));
        if (p.teacherId) teacherBusy.add(resKey(p.teacherId, p.dayOfWeek, sid));
        if (p.roomId) roomBusy.add(resKey(p.roomId, p.dayOfWeek, sid));
      }
      note(p.teacherId, p.dayOfWeek, p.slotIds.length);
    }
  };
  // `search` unwinds all state on failure but leaves it applied on success.
  if (!solved) rebuild();

  // Which blocks are still unplaced after the search?
  const unplacedBlocks: { b: Block; root: boolean }[] = [];
  for (const b of infeasible) unplacedBlocks.push({ b, root: true });
  {
    const remainingBlocks = new Map<string, Block[]>();
    for (const b of feasible) (remainingBlocks.get(b.config.id) ?? remainingBlocks.set(b.config.id, []).get(b.config.id)!).push(b);
    for (const p of best) {
      const list = remainingBlocks.get(p.configId);
      if (!list) continue;
      const at = list.findIndex((b) => b.size === p.slotIds.length);
      if (at >= 0) list.splice(at, 1);
    }
    for (const list of remainingBlocks.values()) for (const b of list) unplacedBlocks.push({ b, root: false });
  }

  // ── Make room ──────────────────────────────────────────────────────────────────
  // For a period that still has no home, look for a slot where the ONLY obstacle is a session of another
  // (unpublished, unlocked) section, move that session somewhere else valid in its own section — and, if
  // that spot is blocked in turn, move that blocker too (a short "ejection chain") — then place the period.
  // Every step obeys the same hard rules as normal placement; a failed attempt is fully undone.
  const moves: SessionMove[] = [];
  const triedMakeRoom = !!input.movable && unplacedBlocks.length > 0;
  if (input.movable && unplacedBlocks.length > 0) {
    const mv = input.movable;
    interface MSess {
      id: string; divisionId: string; configId: string | null; sessionTypeId: string;
      teacherId: string | null; roomId: string | null; size: number; day: number; start: number;
      entryIds: string[]; origDay: number; origStart: number; origRoom: string | null;
      roomType: string | null; span: number;
    }
    interface Spec { divisionId: string; teacherId: string | null; size: number; roomOpts: (string | null)[]; configId: string | null; span: number; sess?: MSess; block?: Block }
    interface RCand { day: number; start: number; room: string | null; blockers: MSess[]; pen: number }

    const MAX_DEPTH = 3;
    const REPAIR_NODE_CAP = 6000;
    const repairDeadline = Date.now() + 2500;
    let repairNodes = 0;

    const slotIdx = new Map(teaching.map((sl, i) => [sl.id, i]));
    const cfgOf = new Map(mv.configs.map((c) => [c.id, c]));
    const divBusyMap = new Map<string, Set<string>>();
    const divSet = (d: string): Set<string> => (d === input.divisionId ? divisionBusy : (divBusyMap.get(d) ?? divBusyMap.set(d, new Set()).get(d)!));
    const cfgCells = new Map<string, string>();   // `${division}|${cell}` → configId
    const cfgDay = new Map<string, number>();     // `${division}|${config}|${day}` → periods
    const sessAtTeacher = new Map<string, MSess>();
    const sessAtRoom = new Map<string, MSess>();

    for (const e of input.otherEntries) {
      divSet(e.divisionId).add(cellKey(e.dayOfWeek, e.slotId));
      if (e.configId && mv.divisionIds.has(e.divisionId)) {
        cfgCells.set(`${e.divisionId}|${cellKey(e.dayOfWeek, e.slotId)}`, e.configId);
        const k = `${e.divisionId}|${e.configId}|${e.dayOfWeek}`;
        cfgDay.set(k, (cfgDay.get(k) ?? 0) + 1);
      }
    }

    // Group movable entries into whole sessions; anything irregular simply stays where it is.
    const groups = new Map<string, EngineEntry[]>();
    for (const e of input.otherEntries) {
      if (!mv.divisionIds.has(e.divisionId) || e.isLocked) continue;
      const k = e.groupId ?? e.id;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
    }
    const sessions: MSess[] = [];
    for (const list of groups.values()) {
      const sorted = [...list].sort((a, b) => (slotIdx.get(a.slotId) ?? -1) - (slotIdx.get(b.slotId) ?? -1));
      const idxs = sorted.map((e) => slotIdx.get(e.slotId));
      if (idxs.some((i) => i === undefined)) continue;
      const start = idxs[0]!;
      const first = sorted[0];
      const regular = days.includes(first.dayOfWeek)
        && sorted.every((e, i) => e.dayOfWeek === first.dayOfWeek && idxs[i] === start + i && runOf[start + i] === runOf[start]
          && e.teacherId === first.teacherId && e.roomId === first.roomId && e.sessionTypeId === first.sessionTypeId);
      if (!regular) continue;
      const cfg = first.configId ? cfgOf.get(first.configId) : undefined;
      sessions.push({
        id: first.groupId ?? first.id, divisionId: first.divisionId, configId: first.configId, sessionTypeId: first.sessionTypeId,
        teacherId: first.teacherId, roomId: first.roomId, size: sorted.length, day: first.dayOfWeek, start,
        entryIds: sorted.map((e) => e.id), origDay: first.dayOfWeek, origStart: start, origRoom: first.roomId,
        roomType: cfg?.roomType ?? input.sessionTypes.get(first.sessionTypeId)?.roomType ?? null,
        span: cfg?.span ?? sorted.length,
      });
    }
    for (const sess of sessions) {
      for (let k = 0; k < sess.size; k++) {
        const slot = teaching[sess.start + k];
        if (sess.teacherId) sessAtTeacher.set(resKey(sess.teacherId, sess.day, slot.id), sess);
        if (sess.roomId) sessAtRoom.set(resKey(sess.roomId, sess.day, slot.id), sess);
      }
    }

    const applySess = (sess: MSess, day: number, start: number, room: string | null, sign: 1 | -1) => {
      const set = divSet(sess.divisionId);
      for (let k = 0; k < sess.size; k++) {
        const slot = teaching[start + k];
        const ck = cellKey(day, slot.id);
        if (sign === 1) set.add(ck); else set.delete(ck);
        if (sess.teacherId) {
          const rk = resKey(sess.teacherId, day, slot.id);
          if (sign === 1) { teacherBusy.add(rk); sessAtTeacher.set(rk, sess); } else { teacherBusy.delete(rk); sessAtTeacher.delete(rk); }
        }
        if (room) {
          const rk = resKey(room, day, slot.id);
          if (sign === 1) { roomBusy.add(rk); sessAtRoom.set(rk, sess); } else { roomBusy.delete(rk); sessAtRoom.delete(rk); }
        }
        if (sess.configId) {
          const key = `${sess.divisionId}|${ck}`;
          if (sign === 1) cfgCells.set(key, sess.configId); else cfgCells.delete(key);
        }
      }
      note(sess.teacherId, day, sign * sess.size);
      if (sess.configId) {
        const k = `${sess.divisionId}|${sess.configId}|${day}`;
        cfgDay.set(k, (cfgDay.get(k) ?? 0) + sign * sess.size);
      }
    };

    const roomOptsOf = (sess: MSess): (string | null)[] => {
      if (!sess.roomId) return [null];
      if (!sess.roomType) return [sess.roomId];
      return [sess.roomId, ...(roomsByType.get(sess.roomType) ?? []).map((r) => r.id).filter((id) => id !== sess.roomId)];
    };
    const specOfSess = (sess: MSess): Spec => ({
      divisionId: sess.divisionId, teacherId: sess.teacherId, size: sess.size, roomOpts: roomOptsOf(sess),
      configId: sess.configId, span: sess.span, sess,
    });

    const softPen = (spec: Spec, day: number, start: number): number => {
      let p = start * 0.1;
      if (!spec.configId) return p;
      const neighbours = [start - 1, start + spec.size].filter((i) => i >= 0 && i < teaching.length && runOf[i] === runOf[start]);
      if (spec.sess) {
        p += (cfgDay.get(`${spec.divisionId}|${spec.configId}|${day}`) ?? 0) * 10;
        if (spec.span <= 1 && neighbours.some((i) => cfgCells.get(`${spec.divisionId}|${cellKey(day, teaching[i].id)}`) === spec.configId)) p += 25;
      } else {
        p += (subjectDay.get(`${spec.configId}|${day}`) ?? 0) * 10;
        if (spec.span <= 1 && neighbours.some((i) => cellConfig.get(cellKey(day, teaching[i].id)) === spec.configId)) p += 25;
      }
      return p;
    };

    /** Every (day, start, room) where `spec` fits if some movable sessions were out of the way. */
    const scan = (spec: Spec, maxBlockers: number, prot: Set<MSess>): RCand[] => {
      const out: RCand[] = [];
      const pref = spec.teacherId ? input.teacherPrefs.get(spec.teacherId) : undefined;
      const dBusy = divSet(spec.divisionId);
      for (const day of days) {
        for (let start = 0; start + spec.size <= teaching.length; start++) {
          if (runOf[start] !== runOf[start + spec.size - 1]) continue;
          let free = true;
          for (let k = 0; k < spec.size && free; k++) if (dBusy.has(cellKey(day, teaching[start + k].id))) free = false;
          if (!free) continue;

          const tBlockers = new Set<MSess>();
          let ok = true;
          if (spec.teacherId) {
            for (let k = 0; k < spec.size && ok; k++) {
              const rk = resKey(spec.teacherId, day, teaching[start + k].id);
              if (input.teacherUnavailable.has(rk)) { ok = false; break; }
              if (teacherBusy.has(rk)) {
                const owner = sessAtTeacher.get(rk);
                if (!owner || prot.has(owner)) ok = false; else tBlockers.add(owner);
              }
            }
          }
          if (!ok || tBlockers.size > maxBlockers) continue;

          if (spec.teacherId && pref) {
            const dayN = teacherDay.get(`${spec.teacherId}|${day}`) ?? 0;
            if (pref.maxPeriodsPerDay != null && dayN + spec.size > pref.maxPeriodsPerDay) continue;
            if (pref.maxPeriodsPerWeek != null && (teacherWeek.get(spec.teacherId) ?? 0) + spec.size > pref.maxPeriodsPerWeek) continue;
            if (pref.maxConsecutive != null) {
              let before = 0;
              for (let i = start - 1; i >= 0 && runOf[i] === runOf[start]; i--) { if (teacherBusy.has(resKey(spec.teacherId, day, teaching[i].id))) before++; else break; }
              let after = 0;
              for (let i = start + spec.size; i < teaching.length && runOf[i] === runOf[start]; i++) { if (teacherBusy.has(resKey(spec.teacherId, day, teaching[i].id))) after++; else break; }
              if (before + spec.size + after > pref.maxConsecutive) continue;
            }
          }

          for (const room of spec.roomOpts) {
            const blockers = new Set(tBlockers);
            let roomOk = true;
            if (room) {
              for (let k = 0; k < spec.size && roomOk; k++) {
                const rk = resKey(room, day, teaching[start + k].id);
                if (input.roomUnavailable.has(rk)) { roomOk = false; break; }
                if (roomBusy.has(rk)) {
                  const owner = sessAtRoom.get(rk);
                  if (!owner || prot.has(owner)) roomOk = false; else blockers.add(owner);
                }
              }
            }
            if (!roomOk || blockers.size > maxBlockers) continue;
            out.push({ day, start, room, blockers: [...blockers], pen: blockers.size * 100 + softPen(spec, day, start) });
          }
        }
      }
      return out;
    };

    const placeSpec = (spec: Spec, cand: RCand, sign: 1 | -1) => {
      if (spec.sess) {
        applySess(spec.sess, cand.day, cand.start, cand.room, sign);
        if (sign === 1) { spec.sess.day = cand.day; spec.sess.start = cand.start; spec.sess.roomId = cand.room; }
      } else {
        apply(spec.block!, { day: cand.day, runStart: cand.start, roomId: cand.room }, sign);
      }
    };

    /** Find a home for `spec`, moving blockers (recursively) if needed. On success the state is updated; on failure it is untouched. */
    const tryPlace = (spec: Spec, depth: number, prot: Set<MSess>): RCand | null => {
      if (depth > MAX_DEPTH) return null;
      if (++repairNodes > REPAIR_NODE_CAP || Date.now() > repairDeadline) return null;
      const cands = scan(spec, depth === 0 ? 3 : 2, prot).sort((a, b) => a.pen - b.pen || a.day - b.day || a.start - b.start).slice(0, 20);
      for (const cand of cands) {
        const origin = cand.blockers.map((b) => ({ b, day: b.day, start: b.start, room: b.roomId }));
        for (const o of origin) applySess(o.b, o.day, o.start, o.room, -1);        // 1. lift the blockers out
        placeSpec(spec, cand, 1);                                                   // 2. put the new session in
        const nextProt = new Set(prot);
        if (spec.sess) nextProt.add(spec.sess);
        const relocated: MSess[] = [];
        let ok = true;
        for (const o of origin) {                                                   // 3. find each blocker a new home
          const r = tryPlace(specOfSess(o.b), depth + 1, nextProt);
          if (!r) { ok = false; break; }
          relocated.push(o.b);
          nextProt.add(o.b);
        }
        if (ok) return cand;
        for (const b of [...relocated].reverse()) applySess(b, b.day, b.start, b.roomId, -1);   // undo everything
        placeSpec(spec, cand, -1);
        for (const o of origin) { o.b.day = o.day; o.b.start = o.start; o.b.roomId = o.room; applySess(o.b, o.day, o.start, o.room, 1); }
      }
      return null;
    };

    const stillUnplaced: typeof unplacedBlocks = [];
    for (const u of [...unplacedBlocks].sort((x, y) => y.b.size - x.b.size)) {
      const c = u.b.config;
      const opts = roomOptions(c);
      const spec: Spec = {
        divisionId: input.divisionId, teacherId: c.teacherId, size: u.b.size, configId: c.id, span: c.span, block: u.b,
        roomOpts: opts === "NONE_AVAILABLE" ? [] : opts,
      };
      const cannotEverPlace = opts === "NONE_AVAILABLE" || (requiresTeacher(c) && !c.teacherId);
      const cand = cannotEverPlace ? null : tryPlace(spec, 0, new Set());
      if (!cand) { stillUnplaced.push(u); continue; }
      best.push({
        configId: c.id, dayOfWeek: cand.day, slotIds: Array.from({ length: u.b.size }, (_, k) => teaching[cand.start + k].id),
        teacherId: c.teacherId, roomId: cand.room,
      });
    }
    unplacedBlocks.length = 0;
    unplacedBlocks.push(...stillUnplaced);

    for (const sess of sessions) {
      if (sess.day === sess.origDay && sess.start === sess.origStart && sess.roomId === sess.origRoom) continue;
      moves.push({
        divisionId: sess.divisionId, configId: sess.configId, entryIds: sess.entryIds,
        fromDay: sess.origDay, fromSlotIds: Array.from({ length: sess.size }, (_, k) => teaching[sess.origStart + k].id),
        toDay: sess.day, toSlotIds: Array.from({ length: sess.size }, (_, k) => teaching[sess.start + k].id), toRoomId: sess.roomId,
      });
    }
  }

  let unplacedCount = 0;
  const explain = (b: Block, rootInfeasible: boolean): string => {
    const c = b.config;
    const lines: string[] = [];
    const st = input.sessionTypes.get(c.sessionTypeId);
    if (requiresTeacher(c) && !c.teacherId) {
      return `${c.label}: no teacher is assigned to this subject for the division. Assign one in Subject setup or Campus → Assign teacher.`;
    }
    const opts = roomOptions(c);
    if (opts === "NONE_AVAILABLE") {
      const type = c.roomType ?? st?.roomType;
      return type
        ? `${c.label}: no active room of type "${type}" exists. Add one in Rooms.`
        : `${c.label}: this session needs a room but none is configured. Pick a room in Subject setup.`;
    }
    if (b.size > 1) {
      const anyRun = teaching.some((_, s) => s + b.size <= teaching.length && runOf[s] === runOf[s + b.size - 1]);
      if (!anyRun) lines.push(`needs ${b.size} consecutive periods but no ${b.size} teaching periods are adjacent (breaks split the day)`);
      else lines.push(`needs ${b.size} consecutive periods`);
    }
    const reasons = new Map<string, number>();
    for (const day of days) {
      for (let start = 0; start + b.size <= teaching.length; start++) {
        if (runOf[start] !== runOf[start + b.size - 1]) continue;
        for (const roomId of opts) checkCandidate(c, b.size, day, start, roomId, false, reasons);
      }
    }
    const tU = new Map<number, Set<string>>();
    const rU = new Map<string, Set<number>>();
    let busyT = 0, lim = 0, divB = 0, roomBusyN = 0;
    for (const [k, n] of reasons) {
      const [r, ...rest] = k.split("|");
      if (r === "TEACHER_UNAVAILABLE") { const [d, s] = rest; (tU.get(Number(d)) ?? tU.set(Number(d), new Set()).get(Number(d))!).add(s); }
      else if (r === "ROOM_UNAVAILABLE") { const [d, , room] = rest; (rU.get(room) ?? rU.set(room, new Set()).get(room)!).add(Number(d)); }
      else if (r === "TEACHER_BUSY") busyT += n;
      else if (r === "TEACHER_LIMIT") lim += n;
      else if (r === "DIVISION_BUSY") divB += n;
      else if (r === "ROOM_BUSY") roomBusyN += n;
    }
    for (const [room, ds] of rU) lines.push(`${labels.room(room)} is unavailable on ${[...ds].sort().map(labels.day).join(", ")}`);
    if (c.teacherId && tU.size) lines.push(`${labels.teacher(c.teacherId)} is unavailable on some periods (${[...tU.keys()].sort().map(labels.day).join(", ")})`);
    if (c.teacherId && busyT) lines.push(`${labels.teacher(c.teacherId)} is already teaching other classes at the remaining times`);
    if (roomBusyN) lines.push(`the room is already booked by other classes at the remaining times`);
    if (lim) lines.push(`${c.teacherId ? labels.teacher(c.teacherId) : "the teacher"}'s workload limits (per day/week/consecutive) would be exceeded`);
    if (divB && !lines.length) lines.push(`the class has no free periods left`);
    if (!lines.length) lines.push(rootInfeasible ? `no valid slot exists` : `the remaining free slots conflict with other sessions`);
    return `${c.label}: ${b.size > 1 ? `${b.size}-period block` : "1 period"} could not be scheduled — ${lines.join("; ")}.`;
  };

  for (const u of unplacedBlocks) {
    unplacedCount += u.b.size;
    problems.push(explain(u.b, u.root));
  }
  if (triedMakeRoom && unplacedCount > 0) {
    problems.push("The generator also tried moving other unpublished sections' unlocked sessions to make room, but no arrangement fit. Check the reasons above — often a teacher or room is simply over-booked.");
  }
  if (timedOut && unplacedCount > 0) problems.push("Search stopped at its time limit; a better arrangement may exist. Try unlocking sessions or relaxing availability.");

  return {
    placements: best,
    complete: unplacedCount === 0,
    placed: best.reduce((n, p) => n + p.slotIds.length, 0),
    unplaced: unplacedCount,
    problems: dedupe(problems),
    timedOut,
    moves,
  };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) if (!seen.has(s)) { seen.add(s); out.push(s); }
  return out;
}
