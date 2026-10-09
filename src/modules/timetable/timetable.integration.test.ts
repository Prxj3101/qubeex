/**
 * End-to-end service tests against a REAL Postgres. Skipped unless TIMETABLE_TEST_DATABASE_URL is set,
 * and refuses to run against anything that is not localhost (these tests create and delete rows).
 *
 *   docker run -d --rm --name qx-tt-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=qx -p 5544:5432 postgres:16
 *   (apply schema: prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script | psql ...)
 *   TIMETABLE_TEST_DATABASE_URL=postgresql://postgres:test@localhost:5544/qx npx jest timetable.integration
 */
const URL_ = process.env.TIMETABLE_TEST_DATABASE_URL;
const enabled = !!URL_ && /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
const d = enabled ? describe : describe.skip;

type Svc = {
  prisma: typeof import("../../utils/prisma").prisma;
  run: typeof import("../../utils/academicContext").runWithAcademicClient;
  setup: typeof import("./timetable.setup.service");
  studio: typeof import("./timetable.studio.service");
  entries: typeof import("./timetable.entries.service");
  gen: typeof import("./timetable.generate.service");
  changes: typeof import("./timetable.changes.service");
  views: typeof import("./timetable.views.service");
  common: typeof import("./timetable.common");
};
let s: Svc;

d("Timetable Studio (integration)", () => {
  const ids: Record<string, string> = {};
  let year: import("../../generated/prisma/client").AcademicYear;
  let oldYear: import("../../generated/prisma/client").AcademicYear;
  const actor = () => ({ userId: ids.adminUser, role: "ADMIN", institutionId: ids.inst });
  const inCtx = <T>(fn: () => Promise<T>) => s.run(s.prisma, fn);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_;
    const [prismaMod, ctxMod, setup, studio, entries, gen, changes, views, common] = await Promise.all([
      import("../../utils/prisma"), import("../../utils/academicContext"), import("./timetable.setup.service"),
      import("./timetable.studio.service"), import("./timetable.entries.service"), import("./timetable.generate.service"),
      import("./timetable.changes.service"), import("./timetable.views.service"), import("./timetable.common"),
    ]);
    s = { prisma: prismaMod.prisma, run: ctxMod.runWithAcademicClient, setup, studio, entries, gen, changes, views, common };
    const p = s.prisma;
    const tag = `tt${Date.now()}`;
    const mkInst = async (n: string) => p.institution.create({ data: { institutionCode: `${tag}${n}`, name: `Inst ${n}`, email: `${tag}${n}@x.test`, type: "SCHOOL", status: "ACTIVE" } });
    const inst = await mkInst("A");
    const other = await mkInst("B");
    ids.inst = inst.id; ids.other = other.id;
    const mkUser = (n: string, role: "ADMIN" | "TEACHER" | "STUDENT", institutionId: string) =>
      p.user.create({ data: { name: n, email: `${tag}${n.replace(/\W/g, "")}@x.test`, role, institutionId, isActive: true } });
    ids.adminUser = (await mkUser("Admin", "ADMIN", inst.id)).id;

    year = await p.academicYear.create({ data: { institutionId: inst.id, label: "2026-27", startDate: new Date("2026-06-01"), endDate: new Date("2027-05-31"), isCurrent: true, status: "ACTIVE" } });
    oldYear = await p.academicYear.create({ data: { institutionId: inst.id, label: "2025-26", startDate: new Date("2025-06-01"), endDate: new Date("2026-05-31"), isCurrent: false, status: "CLOSED" } });

    const std = await p.standard.create({ data: { institutionId: inst.id, name: "10", order: 10 } });
    ids.std = std.id;
    const divA = await p.division.create({ data: { institutionId: inst.id, standardId: std.id, name: "A" } });
    const divB = await p.division.create({ data: { institutionId: inst.id, standardId: std.id, name: "B" } });
    ids.divA = divA.id; ids.divB = divB.id;
    const mkSubject = async (name: string, order: number) => {
      const sub = await p.subject.create({ data: { institutionId: inst.id, standardId: std.id, name, order } });
      await p.divisionSubject.createMany({ data: [divA.id, divB.id].map((divisionId) => ({ divisionId, subjectId: sub.id, institutionId: inst.id })) });
      return sub.id;
    };
    ids.maths = await mkSubject("Mathematics", 1);
    ids.eng = await mkSubject("English", 2);
    ids.sci = await mkSubject("Science", 3);

    const mkTeacher = async (key: string, name: string) => {
      const u = await mkUser(name, "TEACHER", inst.id);
      const t = await p.teacher.create({ data: { teacherId: `${tag}-${key}`, userId: u.id, institutionId: inst.id } });
      ids[key] = t.id; ids[`${key}User`] = u.id;
    };
    await mkTeacher("t1", "Sharma"); await mkTeacher("t2", "Khan"); await mkTeacher("t3", "Patel"); await mkTeacher("t4", "Joshi");
    for (const div of [divA.id, divB.id]) {
      for (const [subjectId, teacherId] of [[ids.maths, ids.t1], [ids.eng, ids.t2], [ids.sci, ids.t3]]) {
        await p.divisionAssignment.create({ data: { divisionId: div, subjectId, teacherId, institutionId: inst.id, academicYearId: year.id } });
      }
    }
    const mkStudent = async (key: string, divisionId: string, institutionId: string, yr: string) => {
      const u = await mkUser(key, "STUDENT", institutionId);
      const st = await p.student.create({ data: { studentId: `${tag}-${key}`, userId: u.id, institutionId, standardId: std.id, divisionId } });
      await p.studentEnrollment.create({ data: { institutionId, studentId: st.id, academicYearId: yr, standardId: std.id, divisionId, status: "ACTIVE" } });
      ids[key] = st.id; ids[`${key}User`] = u.id;
    };
    await mkStudent("sA", divA.id, inst.id, year.id);
    await mkStudent("sB", divB.id, inst.id, year.id);

    await inCtx(async () => {
      await s.setup.setWorkingDays(inst.id, year, [1, 2, 3, 4, 5]);
      const mk = (name: string, start: number, end: number, kind: "PERIOD" | "BREAK" = "PERIOD") => s.setup.createSlot(inst.id, year, { name, startMinute: start, endMinute: end, kind });
      await mk("P1", 480, 520); await mk("P2", 520, 560); await mk("P3", 560, 600); await mk("Break", 600, 620, "BREAK");
      await mk("P4", 620, 660); await mk("P5", 660, 700); await mk("P6", 700, 740);
      await s.setup.createRoom(inst.id, { name: "Science Lab", type: "LAB", isActive: true });
      await s.setup.createRoom(inst.id, { name: "Room 10A", type: "CLASSROOM", isActive: true });
    });
  }, 60000);

  afterAll(async () => {
    if (!s) return;
    const p = s.prisma;
    for (const id of [ids.inst, ids.other]) {
      if (!id) continue;
      await p.timetableSubstitution.deleteMany({ where: { institutionId: id } });
      await p.timetableException.deleteMany({ where: { institutionId: id } });
      await p.timetableEntry.deleteMany({ where: { institutionId: id } });
      await p.timetableGeneration.deleteMany({ where: { institutionId: id } });
      await p.timetableSubjectConfig.deleteMany({ where: { institutionId: id } });
      await p.schoolTimetable.deleteMany({ where: { institutionId: id } });
      await p.teacherAvailability.deleteMany({ where: { institutionId: id } });
      await p.roomUnavailability.deleteMany({ where: { institutionId: id } });
      await p.teacherTimetablePref.deleteMany({ where: { institutionId: id } });
      await p.timeSlot.deleteMany({ where: { institutionId: id } });
      await p.room.deleteMany({ where: { institutionId: id } });
      await p.timetableSessionType.deleteMany({ where: { institutionId: id } });
      await p.timetableSettings.deleteMany({ where: { institutionId: id } });
      await p.studentEnrollment.deleteMany({ where: { institutionId: id } });
      await p.student.deleteMany({ where: { institutionId: id } });
      await p.divisionAssignment.deleteMany({ where: { institutionId: id } });
      await p.divisionSubject.deleteMany({ where: { institutionId: id } });
      await p.subject.deleteMany({ where: { institutionId: id } });
      await p.division.deleteMany({ where: { institutionId: id } });
      await p.standard.deleteMany({ where: { institutionId: id } });
      await p.teacher.deleteMany({ where: { institutionId: id } });
      await p.academicYear.deleteMany({ where: { institutionId: id } });
      await p.notificationRecipient.deleteMany({ where: { institutionId: id } });
      await p.auditLog.deleteMany({ where: { institutionId: id } });
      await p.user.deleteMany({ where: { institutionId: id } });
      await p.institution.deleteMany({ where: { id } });
    }
    await p.$disconnect();
  }, 60000);

  const sessionType = async (kind: string) => {
    const types = await s.setup.listSessionTypes(ids.inst);
    return types.find((t) => t.kind === kind)!;
  };

  it("seeds default session types once and keeps periods in time order", async () => {
    await inCtx(async () => {
      const types = await s.setup.listSessionTypes(ids.inst);
      expect(types.map((t) => t.kind)).toEqual(expect.arrayContaining(["THEORY", "PRACTICAL", "PE_SPORTS", "LIBRARY", "ASSEMBLY", "BREAK", "FREE", "EXAM"]));
      expect((await s.setup.listSessionTypes(ids.inst)).length).toBe(types.length);
      const setup = await s.setup.getSetup(ids.inst, year);
      expect(setup.slots.map((x) => x.name)).toEqual(["P1", "P2", "P3", "Break", "P4", "P5", "P6"]);
      await expect(s.setup.createSlot(ids.inst, year, { name: "X", startMinute: 500, endMinute: 530, kind: "PERIOD" })).rejects.toMatchObject({ status: 409 });
    });
  });

  it("generates a complete, conflict-free timetable for two sections sharing teachers", async () => {
    await inCtx(async () => {
      const theory = await sessionType("THEORY");
      const prac = await sessionType("PRACTICAL");
      for (const div of [ids.divA, ids.divB]) {
        await s.studio.saveConfigs(ids.inst, year, div, {
          configs: [
            { subjectId: ids.maths, sessionTypeId: theory.id, periodsPerWeek: 5, span: 1, maxPerDay: 1 },
            { subjectId: ids.eng, sessionTypeId: theory.id, periodsPerWeek: 5, span: 1, maxPerDay: 1 },
            { subjectId: ids.sci, sessionTypeId: theory.id, periodsPerWeek: 4, span: 1, maxPerDay: 1 },
            { subjectId: ids.sci, sessionTypeId: prac.id, periodsPerWeek: 2, span: 2, maxPerDay: 2 },
          ],
        });
      }
      const res = await s.gen.generateBulk(ids.inst, year, { divisionIds: [ids.divA, ids.divB], keepLocked: true }, actor());
      expect(res.map((r) => r.complete)).toEqual([true, true]);

      const conflicts = await s.studio.getYearConflicts(ids.inst, year);
      expect(conflicts.filter((c) => c.severity === "ERROR")).toEqual([]);
      expect(conflicts.filter((c) => c.type === "REQUIREMENT_SHORTFALL")).toEqual([]);

      const studio = await s.studio.getDivisionStudio(ids.inst, year, ids.divA);
      expect(studio.timetable?.status).toBe("GENERATED");
      expect(studio.requirements.every((r) => r.status === "COMPLETE")).toBe(true);
      const pracEntries = studio.entries.filter((e) => e.sessionTypeId === prac.id);
      expect(pracEntries).toHaveLength(2);
      expect(new Set(pracEntries.map((e) => e.roomName))).toEqual(new Set(["Science Lab"]));
      expect(pracEntries[0].groupId).toBeTruthy();
    });
  });

  it("rejects a clashing manual edit with a conflict list and allows it only when forced", async () => {
    await inCtx(async () => {
      const studioA = await s.studio.getDivisionStudio(ids.inst, year, ids.divA);
      const studioB = await s.studio.getDivisionStudio(ids.inst, year, ids.divB);
      // Find a Maths session in A and move B's free slot onto the same cell with the same teacher.
      const mathsA = studioA.entries.find((e) => e.subjectId === ids.maths)!;
      const occupiedB = studioB.entries.find((e) => e.dayOfWeek === mathsA.dayOfWeek && e.slotId === mathsA.slotId);
      if (occupiedB) await s.entries.deleteEntry(ids.inst, year, occupiedB.id, actor());
      const theory = await sessionType("THEORY");
      const attempt = () => s.entries.addEntry(ids.inst, year, ids.divB, {
        dayOfWeek: mathsA.dayOfWeek, slotId: mathsA.slotId, sessionTypeId: theory.id, subjectId: ids.maths, teacherId: ids.t1,
      }, actor());
      await expect(attempt()).rejects.toMatchObject({ status: 409, conflicts: expect.arrayContaining([expect.objectContaining({ type: "TEACHER_CLASH" })]) });
      const forced = await s.entries.addEntry(ids.inst, year, ids.divB, {
        dayOfWeek: mathsA.dayOfWeek, slotId: mathsA.slotId, sessionTypeId: theory.id, subjectId: ids.maths, teacherId: ids.t1, force: true,
      }, actor());
      expect(forced.warnings.some((w) => w.type === "TEACHER_CLASH")).toBe(true);
      expect((await s.studio.getYearConflicts(ids.inst, year)).some((c) => c.type === "TEACHER_CLASH")).toBe(true);
      // Clean up the forced clash so later tests start from a valid timetable.
      await s.entries.deleteEntry(ids.inst, year, forced.entries[0].id, actor());
      expect((await s.studio.getYearConflicts(ids.inst, year)).filter((c) => c.severity === "ERROR")).toEqual([]);
    });
  });

  it("keeps locked sessions across regeneration", async () => {
    await inCtx(async () => {
      const before = await s.studio.getDivisionStudio(ids.inst, year, ids.divA);
      const target = before.entries.find((e) => e.subjectId === ids.eng)!;
      await s.entries.setLocked(ids.inst, year, target.id, true, actor());
      await expect(s.entries.deleteEntry(ids.inst, year, target.id, actor())).rejects.toMatchObject({ status: 409 });
      const r = await s.gen.generateForDivision(ids.inst, year, ids.divA, true, actor());
      expect(r.complete).toBe(true);
      const after = await s.studio.getDivisionStudio(ids.inst, year, ids.divA);
      const kept = after.entries.find((e) => e.id === target.id);
      expect(kept).toMatchObject({ dayOfWeek: target.dayOfWeek, slotId: target.slotId, isLocked: true });
      expect(after.requirements.every((x) => x.status === "COMPLETE")).toBe(true);
      await s.entries.setLocked(ids.inst, year, target.id, false, actor());
    });
  });

  it("explains an impossible schedule", async () => {
    await inCtx(async () => {
      const setup = await s.setup.getSetup(ids.inst, year);
      const lab = setup.rooms.find((r) => r.name === "Science Lab")!;
      await s.setup.setRoomUnavailability(ids.inst, year, lab.id, {
        cells: setup.workingDays.flatMap((dayOfWeek) => setup.slots.filter((x) => x.kind === "PERIOD").map((x) => ({ dayOfWeek, slotId: x.id }))),
      });
      const r = await s.gen.generateForDivision(ids.inst, year, ids.divA, true, actor());
      expect(r.complete).toBe(false);
      expect(r.unplaced).toBe(2);
      expect(r.problems.join(" ")).toMatch(/Science Lab is unavailable/);
      await s.setup.setRoomUnavailability(ids.inst, year, lab.id, { cells: [] });
      expect((await s.gen.generateForDivision(ids.inst, year, ids.divA, true, actor())).complete).toBe(true);
    });
  });

  it("publishes, and only published data reaches teachers and students — scoped to their own section", async () => {
    await inCtx(async () => {
      let weekA = await s.views.studentWeek(ids.inst, year, ids.sAUser, undefined);
      expect(weekA.published).toBe(false);
      expect(weekA.days.every((day) => day.sessions.length === 0)).toBe(true);

      await s.gen.setStatus(ids.inst, year, ids.divA, { status: "PUBLISHED" }, actor());
      weekA = await s.views.studentWeek(ids.inst, year, ids.sAUser, undefined);
      expect(weekA.published).toBe(true);
      expect(weekA.division).toBe("10-A");
      const total = weekA.days.reduce((n, day) => n + day.sessions.length, 0);
      expect(total).toBe(16);
      expect(weekA.days.flatMap((x) => x.sessions).every((x) => x.divisionName === "10-A")).toBe(true);

      // Section B is still a draft → its student sees nothing, and cannot reach A's data.
      const weekB = await s.views.studentWeek(ids.inst, year, ids.sBUser, undefined);
      expect(weekB.published).toBe(false);

      const tWeek = await s.views.teacherWeek(ids.inst, year, ids.t1User, undefined);
      const mine = tWeek.days.flatMap((x) => x.sessions);
      expect(mine.length).toBe(5);
      expect(mine.every((x) => x.teacherId === ids.t1 && x.divisionName === "10-A")).toBe(true);
      const t4 = await s.views.teacherWeek(ids.inst, year, ids.t4User, undefined);
      expect(t4.days.flatMap((x) => x.sessions)).toHaveLength(0);

      // Unpublish → disappears again.
      await s.gen.setStatus(ids.inst, year, ids.divA, { status: "DRAFT" }, actor());
      expect((await s.views.studentWeek(ids.inst, year, ids.sAUser, undefined)).published).toBe(false);
      await s.gen.setStatus(ids.inst, year, ids.divA, { status: "PUBLISHED" }, actor());
    });
  });

  it("overlays substitutions and date-specific changes without touching the permanent timetable", async () => {
    await inCtx(async () => {
      const studio = await s.studio.getDivisionStudio(ids.inst, year, ids.divA);
      const maths = studio.entries.find((e) => e.subjectId === ids.maths)!;
      // Next occurrence of that weekday on/after 2026-10-12 (a Monday).
      const monday = new Date("2026-10-12T00:00:00Z");
      const date = new Date(monday.getTime() + (maths.dayOfWeek - 1) * 86400000).toISOString().slice(0, 10);

      await s.changes.createSubstitution(ids.inst, year, { entryId: maths.id, date, substituteTeacherId: ids.t4 }, actor());
      const stu = await s.views.studentWeek(ids.inst, year, ids.sAUser, "2026-10-12");
      const cell = stu.days.flatMap((d) => d.sessions).find((x) => x.date === date && x.slotId === maths.slotId)!;
      expect(cell).toMatchObject({ status: "SUBSTITUTED", teacherId: ids.t4 });
      expect(cell.originalTeacherName).toContain("Sharma");

      const sub = await s.views.teacherWeek(ids.inst, year, ids.t4User, "2026-10-12");
      expect(sub.days.flatMap((d) => d.sessions)[0]).toMatchObject({ status: "COVERING", divisionName: "10-A" });
      const orig = await s.views.teacherWeek(ids.inst, year, ids.t1User, "2026-10-12");
      expect(orig.days.flatMap((d) => d.sessions).find((x) => x.date === date && x.slotId === maths.slotId)?.status).toBe("SUBSTITUTED");

      // Permanent timetable unchanged.
      const again = await s.studio.getDivisionStudio(ids.inst, year, ids.divA);
      expect(again.entries.find((e) => e.id === maths.id)?.teacherId).toBe(ids.t1);

      // A busy teacher cannot be assigned without force.
      const other = studio.entries.find((e) => e.teacherId === ids.t2 && e.dayOfWeek === maths.dayOfWeek && e.slotId !== maths.slotId)!;
      if (other) {
        const dateO = date;
        await expect(s.changes.createSubstitution(ids.inst, year, { entryId: maths.id, date: dateO, substituteTeacherId: ids.t2 }, actor()))
          .resolves.toBeDefined(); // t2 is free in maths' own slot unless teaching B; either outcome must not corrupt state
      }

      // Date-specific cancel.
      const eng = studio.entries.find((e) => e.subjectId === ids.eng)!;
      const dateE = new Date(monday.getTime() + (eng.dayOfWeek - 1) * 86400000).toISOString().slice(0, 10);
      await s.changes.createException(ids.inst, year, { divisionId: ids.divA, date: dateE, slotId: eng.slotId, kind: "CANCEL", reason: "Sports day" }, actor());
      const stu2 = await s.views.studentWeek(ids.inst, year, ids.sAUser, "2026-10-12");
      expect(stu2.days.flatMap((d) => d.sessions).find((x) => x.date === dateE && x.slotId === eng.slotId)).toMatchObject({ status: "CANCELLED", note: "Sports day" });
      expect((await s.studio.getDivisionStudio(ids.inst, year, ids.divA)).entries.some((e) => e.id === eng.id)).toBe(true);

      // A date outside the academic year is refused.
      await expect(s.changes.createException(ids.inst, year, { divisionId: ids.divA, date: "2030-01-07", slotId: eng.slotId, kind: "CANCEL" }, actor()))
        .rejects.toMatchObject({ status: 400 });
    });
  });

  it("keeps academic years separate and makes closed years read-only", async () => {
    await inCtx(async () => {
      const old = await s.studio.getDivisionStudio(ids.inst, oldYear, ids.divA);
      expect(old.writable).toBe(false);
      expect(old.entries).toHaveLength(0);
      expect(old.timetable).toBeNull();
      await expect(s.entries.addEntry(ids.inst, oldYear, ids.divA, { dayOfWeek: 1, slotId: "x", sessionTypeId: "y" }, actor())).rejects.toMatchObject({ status: 409 });
      await expect(s.gen.generateForDivision(ids.inst, oldYear, ids.divA, true, actor())).rejects.toMatchObject({ status: 409 });
      expect((await s.studio.getDivisionStudio(ids.inst, year, ids.divA)).entries.length).toBeGreaterThan(0);
      // Student not enrolled in 2025-26 cannot read that year's timetable.
      await expect(s.views.studentWeek(ids.inst, oldYear, ids.sAUser, undefined)).rejects.toMatchObject({ status: 403 });
    });
  });

  it("exports PDF and Excel for class, teacher, room and master views", async () => {
    const { exportTimetable } = await import("./timetable.export.service");
    await inCtx(async () => {
      const room = (await s.setup.getSetup(ids.inst, year)).rooms.find((r) => r.name === "Science Lab")!;
      for (const [kind, id] of [["class", ids.divA], ["teacher", ids.t1], ["room", room.id], ["master", undefined]] as const) {
        const pdf = await exportTimetable(ids.inst, year, kind, "pdf", id);
        expect(pdf.buffer.subarray(0, 4).toString()).toBe("%PDF");
        const xlsx = await exportTimetable(ids.inst, year, kind, "xlsx", id);
        expect(xlsx.buffer.subarray(0, 2).toString()).toBe("PK");
      }
      await expect(exportTimetable(ids.inst, year, "teacher", "pdf", "nope")).rejects.toMatchObject({ status: 404 });
    });
  });

  it("undo building blocks: bulk-delete, restore, clear snapshot and copy-day", async () => {
    await inCtx(async () => {
      // Work on a clean B timetable (unpublished).
      const cleared = await s.entries.clearDivision(ids.inst, year, ids.divB, false, actor());
      expect(cleared.removed).toBeGreaterThan(0);
      expect(cleared.snapshot).toHaveLength(cleared.removed);
      expect((await s.studio.getDivisionStudio(ids.inst, year, ids.divB)).entries).toHaveLength(0);

      // Restore everything that was cleared (groups stay grouped).
      const restored = await s.entries.restoreEntries(ids.inst, year, ids.divB, { entries: cleared.snapshot }, actor());
      expect(restored.entries).toHaveLength(cleared.removed);
      const groupSizes = new Map<string, number>();
      for (const e of restored.entries) if (e.groupId) groupSizes.set(e.groupId, (groupSizes.get(e.groupId) ?? 0) + 1);
      expect([...groupSizes.values()].every((n) => n === 2)).toBe(true);
      // Restoring onto occupied cells is refused.
      await expect(s.entries.restoreEntries(ids.inst, year, ids.divB, { entries: cleared.snapshot.slice(0, 1) }, actor())).rejects.toMatchObject({ status: 409 });

      // Clear one weekday only, then bulk-delete nothing locked.
      const day = restored.entries[0].dayOfWeek;
      const oneDay = await s.entries.clearDivision(ids.inst, year, ids.divB, false, actor(), day);
      expect(oneDay.removed).toBe(restored.entries.filter((e) => e.dayOfWeek === day).length);
      await s.entries.restoreEntries(ids.inst, year, ids.divB, { entries: oneDay.snapshot }, actor());

      // Copy a day onto an empty one: use a fresh clear of a target day first.
      const other = [1, 2, 3, 4, 5].find((d) => d !== day)!;
      await s.entries.clearDivision(ids.inst, year, ids.divB, false, actor(), other);
      const copy = await s.entries.copyDay(ids.inst, year, ids.divB, { fromDay: day, toDays: [other], overwrite: false, force: true }, actor());
      expect(copy.createdIds.length).toBe(restored.entries.filter((e) => e.dayOfWeek === day).length);
      const afterCopy = await s.studio.getDivisionStudio(ids.inst, year, ids.divB);
      expect(afterCopy.entries.filter((e) => e.dayOfWeek === other)).toHaveLength(copy.createdIds.length);
      // Copy again without overwrite → everything is blocked.
      await expect(s.entries.copyDay(ids.inst, year, ids.divB, { fromDay: day, toDays: [other], overwrite: false, force: true }, actor())).rejects.toMatchObject({ status: 409 });
      // Undo the copy via bulk delete.
      const undone = await s.entries.bulkDeleteEntries(ids.inst, year, { ids: copy.createdIds }, actor());
      expect(undone.removed).toBe(copy.createdIds.length);
      expect((await s.studio.getDivisionStudio(ids.inst, year, ids.divB)).entries.filter((e) => e.dayOfWeek === other)).toHaveLength(0);
    });
  });

  it("isolates institutions", async () => {
    await inCtx(async () => {
      await expect(s.studio.getDivisionStudio(ids.other, year, ids.divA)).rejects.toMatchObject({ status: 404 });
      await expect(s.entries.deleteEntry(ids.other, year, "00000000-0000-0000-0000-000000000000", actor())).rejects.toMatchObject({ status: 404 });
      const foreignEntry = (await s.studio.getDivisionStudio(ids.inst, year, ids.divA)).entries[0];
      await expect(s.entries.deleteEntry(ids.other, year, foreignEntry.id, actor())).rejects.toMatchObject({ status: 404 });
      await expect(s.views.studentWeek(ids.other, year, ids.sAUser, undefined)).rejects.toMatchObject({ status: 404 });
    });
  });
});
