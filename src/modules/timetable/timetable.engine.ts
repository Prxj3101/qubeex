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

  for (const b of infeasible) {
    unplacedCount += b.size;
    problems.push(explain(b, true));
  }
  // Match placed placements to feasible blocks to determine which feasible blocks remain unplaced.
  const remainingBlocks = new Map<string, Block[]>();
  for (const b of feasible) (remainingBlocks.get(b.config.id) ?? remainingBlocks.set(b.config.id, []).get(b.config.id)!).push(b);
  for (const p of best) {
    const list = remainingBlocks.get(p.configId);
    if (!list) continue;
    const at = list.findIndex((b) => b.size === p.slotIds.length);
    if (at >= 0) list.splice(at, 1);
  }
  for (const list of remainingBlocks.values()) {
    for (const b of list) {
      unplacedCount += b.size;
      problems.push(explain(b, false));
    }
  }
  if (timedOut && unplacedCount > 0) problems.push("Search stopped at its time limit; a better arrangement may exist. Try unlocking sessions or relaxing availability.");

  return {
    placements: best,
    complete: unplacedCount === 0,
    placed: best.reduce((n, p) => n + p.slotIds.length, 0),
    unplaced: unplacedCount,
    problems: dedupe(problems),
    timedOut,
  };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) if (!seen.has(s)) { seen.add(s); out.push(s); }
  return out;
}
