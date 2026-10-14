import {
  detectConflicts,
  generateTimetable,
  requirementStatus,
  DAY_NAMES,
  resKey,
  type EngineConfig,
  type EngineEntry,
  type EngineSessionType,
  type EngineSlot,
  type GeneratorInput,
  type Labels,
} from "./timetable.engine";

const labels: Labels = {
  teacher: (id) => `T:${id}`,
  room: (id) => `R:${id}`,
  division: (id) => `D:${id}`,
  slot: (id) => `S:${id}`,
  day: (d) => DAY_NAMES[d],
};

// P1 P2 BREAK P3 P4
const slots: EngineSlot[] = [
  { id: "p1", name: "P1", order: 1, startMinute: 480, endMinute: 520, kind: "PERIOD" },
  { id: "p2", name: "P2", order: 2, startMinute: 520, endMinute: 560, kind: "PERIOD" },
  { id: "br", name: "Break", order: 3, startMinute: 560, endMinute: 580, kind: "BREAK" },
  { id: "p3", name: "P3", order: 4, startMinute: 580, endMinute: 620, kind: "PERIOD" },
  { id: "p4", name: "P4", order: 5, startMinute: 620, endMinute: 660, kind: "PERIOD" },
];

const types = new Map<string, EngineSessionType>([
  ["theory", { id: "theory", name: "Theory", kind: "THEORY", requiresTeacher: true, requiresRoom: false, roomType: null }],
  ["prac", { id: "prac", name: "Practical", kind: "PRACTICAL", requiresTeacher: true, requiresRoom: true, roomType: "LAB" }],
]);

const rooms = [
  { id: "lab1", name: "Science Lab", type: "LAB", isActive: true },
  { id: "cr1", name: "Room 1", type: "CLASSROOM", isActive: true },
];

const cfg = (o: Partial<EngineConfig> & { id: string }): EngineConfig => ({
  divisionId: "10A", subjectId: "s", sessionTypeId: "theory", label: o.id, periodsPerWeek: 1, span: 1,
  maxPerDay: 1, teacherId: "t1", roomId: null, roomType: null, ...o,
});

const base = (over: Partial<GeneratorInput>): GeneratorInput => ({
  divisionId: "10A", slots, workingDays: [1, 2, 3], configs: [], sessionTypes: types, rooms,
  lockedEntries: [], otherEntries: [], teacherUnavailable: new Set(), teacherPreferred: new Set(),
  roomUnavailable: new Set(), teacherPrefs: new Map(), labels, ...over,
});

const entry = (o: Partial<EngineEntry> & { id: string }): EngineEntry => ({
  divisionId: "10A", dayOfWeek: 1, slotId: "p1", sessionTypeId: "theory", subjectId: "s", teacherId: "t1",
  roomId: null, configId: null, groupId: null, isLocked: false, ...o,
});

const conflictInput = (entries: EngineEntry[], over = {}) => ({
  entries, slots, workingDays: [1, 2, 3], sessionTypes: types,
  rooms: new Map(rooms.map((r) => [r.id, r])), teacherUnavailable: new Set<string>(),
  roomUnavailable: new Set<string>(), labels, ...over,
});

describe("detectConflicts", () => {
  it("flags a teacher teaching two divisions at once", () => {
    const c = detectConflicts(conflictInput([entry({ id: "a" }), entry({ id: "b", divisionId: "9B" })]));
    expect(c.filter((x) => x.type === "TEACHER_CLASH")).toHaveLength(1);
  });

  it("flags a room double-booking and an incompatible room", () => {
    const c = detectConflicts(conflictInput([
      entry({ id: "a", sessionTypeId: "prac", roomId: "lab1", teacherId: "t1" }),
      entry({ id: "b", divisionId: "9B", sessionTypeId: "prac", roomId: "lab1", teacherId: "t2" }),
      entry({ id: "c", dayOfWeek: 2, sessionTypeId: "prac", roomId: "cr1", teacherId: "t3" }),
    ]));
    expect(c.some((x) => x.type === "ROOM_CLASH")).toBe(true);
    expect(c.some((x) => x.type === "ROOM_INCOMPATIBLE")).toBe(true);
  });

  it("flags unavailable teacher, break slot and non-working day", () => {
    const c = detectConflicts(conflictInput(
      [entry({ id: "a" }), entry({ id: "b", slotId: "br", dayOfWeek: 2 }), entry({ id: "c", dayOfWeek: 6, slotId: "p2" })],
      { teacherUnavailable: new Set([resKey("t1", 1, "p1")]) }
    ));
    const types2 = c.map((x) => x.type);
    expect(types2).toContain("TEACHER_UNAVAILABLE");
    expect(types2).toContain("NON_TEACHING_SLOT");
    expect(types2).toContain("OUTSIDE_WORKING_DAY");
  });

  it("flags a practical group split by the break", () => {
    const c = detectConflicts(conflictInput([
      entry({ id: "a", slotId: "p2", sessionTypeId: "prac", roomId: "lab1", groupId: "g" }),
      entry({ id: "b", slotId: "p3", sessionTypeId: "prac", roomId: "lab1", groupId: "g" }),
    ]));
    expect(c.some((x) => x.type === "PRACTICAL_NOT_CONSECUTIVE")).toBe(true);
  });

  it("does not flag a practical group on adjacent periods", () => {
    const c = detectConflicts(conflictInput([
      entry({ id: "a", slotId: "p3", sessionTypeId: "prac", roomId: "lab1", groupId: "g" }),
      entry({ id: "b", slotId: "p4", sessionTypeId: "prac", roomId: "lab1", groupId: "g" }),
    ]));
    expect(c.some((x) => x.type === "PRACTICAL_NOT_CONSECUTIVE")).toBe(false);
  });
});

describe("requirementStatus", () => {
  it("reports complete / incomplete", () => {
    const configs = [cfg({ id: "m", periodsPerWeek: 2 }), cfg({ id: "p", periodsPerWeek: 2 })];
    const st = requirementStatus(configs, [entry({ id: "1", configId: "m" }), entry({ id: "2", configId: "m", slotId: "p2" }), entry({ id: "3", configId: "p" })]);
    expect(st.find((x) => x.configId === "m")?.status).toBe("COMPLETE");
    expect(st.find((x) => x.configId === "p")?.status).toBe("INCOMPLETE");
  });
});

describe("generateTimetable", () => {
  it("fulfils weekly requirements without any hard-constraint violation", () => {
    const configs = [
      cfg({ id: "math", periodsPerWeek: 3, teacherId: "t1" }),
      cfg({ id: "eng", periodsPerWeek: 3, teacherId: "t2" }),
      cfg({ id: "prac", sessionTypeId: "prac", periodsPerWeek: 2, span: 2, teacherId: "t3", roomType: "LAB" }),
    ];
    const r = generateTimetable(base({ configs }));
    expect(r.complete).toBe(true);
    expect(r.placed).toBe(8);
    const entries: EngineEntry[] = [];
    for (const p of r.placements) {
      const gid = p.slotIds.length > 1 ? `g-${p.configId}` : null;
      const c = configs.find((x) => x.id === p.configId)!;
      p.slotIds.forEach((sid, i) =>
        entries.push(entry({ id: `${p.configId}-${p.dayOfWeek}-${i}`, dayOfWeek: p.dayOfWeek, slotId: sid, sessionTypeId: c.sessionTypeId, teacherId: p.teacherId, roomId: p.roomId, configId: p.configId, groupId: gid }))
      );
    }
    const conflicts = detectConflicts(conflictInput(entries)).filter((x) => x.severity === "ERROR");
    expect(conflicts).toEqual([]);
  });

  it("is deterministic", () => {
    const configs = [cfg({ id: "a", periodsPerWeek: 3 }), cfg({ id: "b", periodsPerWeek: 3, teacherId: "t2" })];
    expect(generateTimetable(base({ configs }))).toEqual(generateTimetable(base({ configs })));
  });

  it("avoids slots where another division already has the teacher", () => {
    const other = [1, 2, 3].flatMap((d) => ["p1", "p2", "p3"].map((s) => entry({ id: `${d}${s}`, divisionId: "9B", dayOfWeek: d, slotId: s })));
    const r = generateTimetable(base({ configs: [cfg({ id: "a", periodsPerWeek: 3 })], otherEntries: other }));
    expect(r.complete).toBe(true);
    expect(r.placements.every((p) => p.slotIds[0] === "p4")).toBe(true);
  });

  it("keeps locked entries and only fills the remainder", () => {
    const locked = [entry({ id: "L", configId: "a", dayOfWeek: 1, slotId: "p1", isLocked: true })];
    const r = generateTimetable(base({ configs: [cfg({ id: "a", periodsPerWeek: 3 })], lockedEntries: locked }));
    expect(r.placed).toBe(2);
    expect(r.placements.some((p) => p.dayOfWeek === 1 && p.slotIds.includes("p1"))).toBe(false);
  });

  it("explains an impossible practical (lab unavailable, teacher unavailable)", () => {
    const configs = [cfg({ id: "Science Practical", sessionTypeId: "prac", periodsPerWeek: 2, span: 2, teacherId: "t3", roomId: "lab1" })];
    const roomUnavailable = new Set<string>();
    const teacherUnavailable = new Set<string>();
    for (const d of [1, 2, 3]) for (const s of ["p1", "p2", "p3", "p4"]) roomUnavailable.add(resKey("lab1", d, s));
    const r = generateTimetable(base({ configs, roomUnavailable, teacherUnavailable }));
    expect(r.complete).toBe(false);
    expect(r.unplaced).toBe(2);
    expect(r.problems.join(" ")).toMatch(/R:lab1 is unavailable/);
  });

  it("reports when no teacher is assigned", () => {
    const r = generateTimetable(base({ configs: [cfg({ id: "orphan", teacherId: null })] }));
    expect(r.complete).toBe(false);
    expect(r.problems[0]).toMatch(/no teacher/);
  });

  it("relaxes max-per-day when needed to place everything", () => {
    // 4 periods but only 3 working days with maxPerDay=1 → must double up on one day.
    const r = generateTimetable(base({ configs: [cfg({ id: "a", periodsPerWeek: 4, maxPerDay: 1 })] }));
    expect(r.complete).toBe(true);
  });

  it("respects teacher max periods per day", () => {
    const prefs = new Map([["t1", { maxPeriodsPerDay: 1, maxConsecutive: null, maxPeriodsPerWeek: null }]]);
    const r = generateTimetable(base({ configs: [cfg({ id: "a", periodsPerWeek: 4 })], teacherPrefs: prefs }));
    expect(r.complete).toBe(false);
    expect(r.placed).toBe(3);
  });

  it("keeps two periods of the same subject apart when room allows (no back-to-back)", () => {
    // One working day, periods P1 P2 | Break | P3 P4. Two Maths periods with maxPerDay 2 must not touch.
    const r = generateTimetable(base({ workingDays: [1], configs: [cfg({ id: "m", periodsPerWeek: 2, maxPerDay: 2 })] }));
    expect(r.complete).toBe(true);
    const order = new Map(slots.map((s) => [s.id, s.order]));
    const [a, b] = r.placements.map((p) => order.get(p.slotIds[0])!).sort((x, y) => x - y);
    // adjacent in the same run would be (1,2) or (4,5); across the break (2,4) is fine
    expect([[1, 2], [4, 5]].some(([x, y]) => x === a && y === b)).toBe(false);
  });

  it("still places everything when adjacency is unavoidable", () => {
    // 3 Maths periods on one day with only P1,P2,P3,P4 around a break → some touching is unavoidable.
    const r = generateTimetable(base({ workingDays: [1], configs: [cfg({ id: "m", periodsPerWeek: 3, maxPerDay: 3 })] }));
    expect(r.complete).toBe(true);
  });

  it("different seeds give different valid arrangements; the same seed repeats", () => {
    const configs = [cfg({ id: "a", periodsPerWeek: 3 }), cfg({ id: "b", periodsPerWeek: 3, teacherId: "t2" }), cfg({ id: "c", periodsPerWeek: 2, teacherId: "t3" })];
    const key = (seed: number) => JSON.stringify(generateTimetable(base({ configs, seed })).placements);
    expect(key(1)).toBe(key(1));
    const variants = new Set([1, 2, 3, 4, 5, 6].map(key));
    expect(variants.size).toBeGreaterThan(1);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = generateTimetable(base({ configs, seed }));
      expect(r.complete).toBe(true);
      // never two sessions in one cell, never a teacher twice in one cell
      const cells = r.placements.flatMap((p) => p.slotIds.map((s) => `${p.dayOfWeek}|${s}`));
      expect(new Set(cells).size).toBe(cells.length);
    }
  });

});

describe("generateTimetable — making room by moving other unpublished sections", () => {
  const prac = (id: string, divisionId: string, teacherId: string, over: Partial<EngineConfig> = {}): EngineConfig =>
    cfg({ id, divisionId, sessionTypeId: "prac", periodsPerWeek: 2, span: 2, maxPerDay: 2, teacherId, roomType: "LAB", ...over });
  const labEntries = (divisionId: string, teacherId: string, configId: string, day: number, a: string, b: string, group: string, locked = false): EngineEntry[] =>
    [a, b].map((slotId) => entry({ id: `${group}-${slotId}`, divisionId, dayOfWeek: day, slotId, sessionTypeId: "prac", teacherId, roomId: "lab1", configId, groupId: group, isLocked: locked }));
  const unavailable = (teacher: string, cells: [number, string][]) => new Set(cells.map(([d, sl]) => resKey(teacher, d, sl)));
  const allSlots = ["p1", "p2", "p3", "p4"];
  const onlyLab = [rooms[0]]; // one lab → labs are the contested resource

  // 10A's teacher t3 can only teach Mon P1-P2, which 10B's lab session currently occupies.
  const scenario = (over: Partial<GeneratorInput> = {}) =>
    base({
      workingDays: [1, 2],
      rooms: onlyLab,
      configs: [prac("a", "10A", "t3")],
      teacherUnavailable: unavailable("t3", [[1, "p3"], [1, "p4"], ...allSlots.map((x): [number, string] => [2, x])]),
      otherEntries: labEntries("10B", "t4", "b", 1, "p1", "p2", "gB"),
      movable: { divisionIds: new Set(["10B"]), configs: [prac("b", "10B", "t4")] },
      ...over,
    });

  /** The final state of everything — ours plus the moved sessions — must have no clashes at all. */
  const finalConflicts = (r: ReturnType<typeof generateTimetable>, others: EngineEntry[], unavail: Set<string>) => {
    const moved = new Map(r.moves.flatMap((m) => m.entryIds.map((id, i) => [id, { m, i }] as const)));
    const all: EngineEntry[] = others.map((e) => {
      const mv = moved.get(e.id);
      return mv ? { ...e, dayOfWeek: mv.m.toDay, slotId: mv.m.toSlotIds[mv.i], roomId: mv.m.toRoomId } : e;
    });
    for (const p of r.placements) {
      p.slotIds.forEach((sid, i) => all.push(entry({ id: `new-${p.configId}-${i}`, divisionId: "10A", dayOfWeek: p.dayOfWeek, slotId: sid, sessionTypeId: "prac", teacherId: p.teacherId, roomId: p.roomId, configId: p.configId, groupId: `g-${p.configId}` })));
    }
    return detectConflicts(conflictInput(all, { rooms: new Map(onlyLab.map((x) => [x.id, x])), teacherUnavailable: unavail, workingDays: [1, 2] })).filter((c) => c.severity === "ERROR");
  };

  it("without permission to move other sections the period stays unplaced", () => {
    const r = generateTimetable(scenario({ movable: undefined }));
    expect(r.complete).toBe(false);
    expect(r.unplaced).toBe(2);
    expect(r.moves).toEqual([]);
  });

  it("moves the other section's session out of the way and fills the hole", () => {
    const input = scenario();
    const r = generateTimetable(input);
    expect(r.complete).toBe(true);
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]).toMatchObject({ dayOfWeek: 1, slotIds: ["p1", "p2"], roomId: "lab1" });
    expect(r.moves).toHaveLength(1);
    expect(r.moves[0]).toMatchObject({ divisionId: "10B", entryIds: ["gB-p1", "gB-p2"], fromDay: 1, fromSlotIds: ["p1", "p2"] });
    expect(r.moves[0].toSlotIds).toHaveLength(2);            // the 2-period block stays together…
    expect(finalConflicts(r, input.otherEntries, input.teacherUnavailable)).toEqual([]); // …and nothing clashes
    // 10B still has all of its periods (moved, not dropped).
    expect(r.moves[0].entryIds).toHaveLength(2);
  });

  it("never moves locked sessions", () => {
    const r = generateTimetable(scenario({ otherEntries: labEntries("10B", "t4", "b", 1, "p1", "p2", "gB", true) }));
    expect(r.complete).toBe(false);
    expect(r.moves).toEqual([]);
  });

  it("never moves sections that aren't listed as movable (published / archived)", () => {
    const r = generateTimetable(scenario({ movable: { divisionIds: new Set(), configs: [] } }));
    expect(r.complete).toBe(false);
    expect(r.moves).toEqual([]);
  });

  it("chains two moves when the first session's only alternative is also taken", () => {
    // 10B's t4 can't teach on day 2, so 10B can only go to Mon P3-P4 — where 10C's session sits. 10C can go to day 2.
    const others = [...labEntries("10B", "t4", "b", 1, "p1", "p2", "gB"), ...labEntries("10C", "t5", "c", 1, "p3", "p4", "gC")];
    const unavail = new Set([...scenario().teacherUnavailable, ...unavailable("t4", allSlots.map((x): [number, string] => [2, x]))]);
    const input = scenario({
      otherEntries: others,
      teacherUnavailable: unavail,
      movable: { divisionIds: new Set(["10B", "10C"]), configs: [prac("b", "10B", "t4"), prac("c", "10C", "t5")] },
    });
    const r = generateTimetable(input);
    expect(r.complete).toBe(true);
    expect(r.moves).toHaveLength(2);
    const b = r.moves.find((m) => m.divisionId === "10B")!;
    const c = r.moves.find((m) => m.divisionId === "10C")!;
    expect(b.toDay).toBe(1);
    expect(b.toSlotIds).toEqual(["p3", "p4"]);
    expect(c.toDay).toBe(2);
    expect(finalConflicts(r, others, unavail)).toEqual([]);
  });

  it("leaves everything exactly as it was when no chain of moves can work", () => {
    // Same as above but 10C also has nowhere to go (t5 is unavailable on day 2).
    const others = [...labEntries("10B", "t4", "b", 1, "p1", "p2", "gB"), ...labEntries("10C", "t5", "c", 1, "p3", "p4", "gC")];
    const unavail = new Set([
      ...scenario().teacherUnavailable,
      ...unavailable("t4", allSlots.map((x): [number, string] => [2, x])),
      ...unavailable("t5", allSlots.map((x): [number, string] => [2, x])),
    ]);
    const r = generateTimetable(scenario({
      otherEntries: others, teacherUnavailable: unavail,
      movable: { divisionIds: new Set(["10B", "10C"]), configs: [prac("b", "10B", "t4"), prac("c", "10C", "t5")] },
    }));
    expect(r.complete).toBe(false);
    expect(r.moves).toEqual([]);                 // fully rolled back — other sections untouched
    expect(r.problems.join(" ")).toMatch(/tried moving other unpublished/i);
  });
});
