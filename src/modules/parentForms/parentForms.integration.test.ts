/**
 * Service tests against a REAL Postgres. Skipped unless PARENT_FORMS_TEST_DATABASE_URL is set,
 * and refuses to run against anything that is not localhost (these tests create and delete rows).
 *
 *   docker run -d --rm --name qx-forms-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=qx -p 5546:5432 postgres:16
 *   (apply schema: prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script | psql ...)
 *   PARENT_FORMS_TEST_DATABASE_URL=postgresql://postgres:test@localhost:5546/qx npx jest parentForms.integration
 */
export {};

const URL_ = process.env.PARENT_FORMS_TEST_DATABASE_URL;
const enabled = !!URL_ && /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
const d = enabled ? describe : describe.skip;

type Svc = {
  prisma: typeof import("../../utils/prisma").prisma;
  run: typeof import("../../utils/academicContext").runWithAcademicClient;
  forms: typeof import("../../services/parentForms.service");
  ptm: typeof import("../../services/ptm.service");
};
let s: Svc;

d("Parent forms & PTM scheduler (integration)", () => {
  const ids: Record<string, string> = {};
  const inCtx = <T>(fn: () => Promise<T>) => s.run(s.prisma, fn);
  const teacherActor = (key: string) => ({ userId: ids[`${key}User`], role: "TEACHER" as const, institutionId: ids.inst });
  const adminActor = () => ({ userId: ids.adminUser, role: "ADMIN" as const, institutionId: ids.inst });
  const tomorrow = () => s.ptm.istDateString(new Date(Date.now() + 24 * 60 * 60 * 1000));

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_;
    const [prismaMod, ctxMod, forms, ptm] = await Promise.all([
      import("../../utils/prisma"),
      import("../../utils/academicContext"),
      import("../../services/parentForms.service"),
      import("../../services/ptm.service"),
    ]);
    s = { prisma: prismaMod.prisma, run: ctxMod.runWithAcademicClient, forms, ptm };
    const p = s.prisma;
    const tag = `pf${Date.now()}`;

    const inst = await p.institution.create({ data: { institutionCode: `${tag}A`, name: "Inst A", email: `${tag}A@x.test`, type: "SCHOOL", status: "ACTIVE" } });
    ids.inst = inst.id;
    const mkUser = (n: string, role: "ADMIN" | "TEACHER" | "STUDENT") =>
      p.user.create({ data: { name: n, email: `${tag}${n.replace(/\W/g, "")}@x.test`, role, institutionId: inst.id, isActive: true } });
    ids.adminUser = (await mkUser("Admin", "ADMIN")).id;

    const year = await p.academicYear.create({ data: { institutionId: inst.id, label: "2026-27", startDate: new Date("2026-06-01"), endDate: new Date("2027-05-31"), isCurrent: true, status: "ACTIVE" } });
    const std = await p.standard.create({ data: { institutionId: inst.id, name: "10", order: 10 } });
    const divA = await p.division.create({ data: { institutionId: inst.id, standardId: std.id, name: "A" } });
    const divB = await p.division.create({ data: { institutionId: inst.id, standardId: std.id, name: "B" } });
    ids.divA = divA.id;
    ids.divB = divB.id;
    const maths = await p.subject.create({ data: { institutionId: inst.id, standardId: std.id, name: "Mathematics", order: 1 } });

    const mkTeacher = async (key: string, name: string) => {
      const u = await mkUser(name, "TEACHER");
      const t = await p.teacher.create({ data: { teacherId: `${tag}-${key}`, userId: u.id, institutionId: inst.id } });
      ids[key] = t.id;
      ids[`${key}User`] = u.id;
    };
    await mkTeacher("classT", "ClassTeacher");
    await mkTeacher("plainT", "PlainTeacher");
    await mkTeacher("otherT", "OtherClassTeacher");
    await p.division.update({ where: { id: divA.id }, data: { classTeacherId: ids.classT } });
    await p.division.update({ where: { id: divB.id }, data: { classTeacherId: ids.otherT } });
    await p.divisionAssignment.create({ data: { divisionId: divA.id, subjectId: maths.id, teacherId: ids.plainT, institutionId: inst.id, academicYearId: year.id } });

    const mkStudent = async (key: string, divisionId: string) => {
      const u = await mkUser(key, "STUDENT");
      const st = await p.student.create({ data: { studentId: `${tag}-${key}`, userId: u.id, institutionId: inst.id, standardId: std.id, divisionId } });
      ids[key] = st.id;
      ids[`${key}User`] = u.id;
    };
    await mkStudent("sA", divA.id);
    await mkStudent("sA2", divA.id);
    await mkStudent("sB", divB.id);
  });

  afterAll(async () => {
    if (!s) return;
    const p = s.prisma;
    const id = ids.inst;
    if (!id) return; // never deleteMany with an undefined institutionId — Prisma treats it as "no filter"
    await p.ptmSlot.deleteMany({ where: { institutionId: id } });
    await p.ptmSession.deleteMany({ where: { institutionId: id } });
    await p.parentFormResponse.deleteMany({ where: { institutionId: id } });
    await p.parentFormTarget.deleteMany({ where: { institutionId: id } });
    await p.parentForm.deleteMany({ where: { institutionId: id } });
    await p.student.deleteMany({ where: { institutionId: id } });
    await p.divisionAssignment.deleteMany({ where: { institutionId: id } });
    await p.subject.deleteMany({ where: { institutionId: id } });
    await p.division.deleteMany({ where: { institutionId: id } });
    await p.standard.deleteMany({ where: { institutionId: id } });
    await p.teacher.deleteMany({ where: { institutionId: id } });
    await p.academicYear.deleteMany({ where: { institutionId: id } });
    await p.notificationRecipient.deleteMany({ where: { institutionId: id } });
    await p.auditLog.deleteMany({ where: { institutionId: id } });
    await p.user.deleteMany({ where: { institutionId: id } });
    await p.institution.deleteMany({ where: { id } });
    await p.$disconnect();
  });

  // ── Forms ──────────────────────────────────────────────────────────────────

  it("only a class teacher can send forms", () =>
    inCtx(async () => {
      await expect(s.forms.createForm(teacherActor("plainT"), { kind: "SLIP", title: "Trip", allowComment: true })).rejects.toThrow(/class teacher/);
    }));

  it("validates poll options and fixes slip options to Yes/No", () =>
    inCtx(async () => {
      await expect(s.forms.createForm(teacherActor("classT"), { kind: "POLL", title: "Lunch", options: ["Only one"], allowComment: true })).rejects.toThrow(/between 2 and 6/);
      const created = await s.forms.createForm(teacherActor("classT"), { kind: "SLIP", title: "Museum trip", description: "Fri 9am", allowComment: true });
      ids.slip = created.id;
      expect(created.audience).toBe(2); // sA + sA2 (divA only)
      const results = await s.forms.getFormResults(teacherActor("classT"), created.id);
      expect(results.options).toEqual(["Yes", "No"]);
    }));

  it("a class teacher cannot target another teacher's class", () =>
    inCtx(async () => {
      await expect(
        s.forms.createForm(teacherActor("classT"), { kind: "SLIP", title: "x", allowComment: true, divisionIds: [ids.divB] })
      ).rejects.toThrow(/own classes/);
    }));

  it("shows a form only to students in the targeted division", () =>
    inCtx(async () => {
      const a = await s.forms.listFormsForStudent(ids.sAUser, ids.inst);
      expect(a.forms.map((f) => f.id)).toContain(ids.slip);
      expect(a.pending).toBe(1);
      const b = await s.forms.listFormsForStudent(ids.sBUser, ids.inst);
      expect(b.forms.map((f) => f.id)).not.toContain(ids.slip);
      await expect(s.forms.respondToForm(ids.sBUser, ids.inst, ids.slip, { optionIndex: 0 })).rejects.toThrow(/not found/i);
    }));

  it("lets a parent answer and change their answer, keeping the audit trail", () =>
    inCtx(async () => {
      await s.forms.respondToForm(ids.sAUser, ids.inst, ids.slip, { optionIndex: 0, comment: "Happy to send" });
      expect(await s.forms.pendingFormCountForStudent(ids.sAUser, ids.inst)).toBe(0);
      await s.forms.respondToForm(ids.sAUser, ids.inst, ids.slip, { optionIndex: 1, comment: "Changed my mind" });

      const results = await s.forms.getFormResults(teacherActor("classT"), ids.slip);
      expect(results.counts).toEqual([{ label: "Yes", count: 0 }, { label: "No", count: 1 }]);
      expect(results.answered).toBe(1);
      expect(results.total).toBe(2);
      const row = results.students.find((r) => r.studentId === ids.sA);
      expect(row).toMatchObject({ optionIndex: 1, comment: "Changed my mind", changes: 1 });
      await expect(s.forms.respondToForm(ids.sAUser, ids.inst, ids.slip, { optionIndex: 5 })).rejects.toThrow(/Invalid choice/);
    }));

  it("another teacher cannot read someone else's results", () =>
    inCtx(async () => {
      await expect(s.forms.getFormResults(teacherActor("otherT"), ids.slip)).rejects.toThrow(/not found/i);
    }));

  it("stops accepting answers after the deadline or when closed", () =>
    inCtx(async () => {
      const dl = await s.forms.createForm(teacherActor("classT"), { kind: "POLL", title: "Colour", options: ["Red", "Blue"], allowComment: false, deadline: new Date(Date.now() + 60_000) });
      await s.prisma.parentForm.update({ where: { id: dl.id }, data: { deadline: new Date(Date.now() - 1000) } });
      await expect(s.forms.respondToForm(ids.sAUser, ids.inst, dl.id, { optionIndex: 0 })).rejects.toThrow(/closed/);

      const open = await s.forms.createForm(teacherActor("classT"), { kind: "POLL", title: "Snack", options: ["Fruit", "Biscuit"], allowComment: false });
      await s.forms.respondToForm(ids.sAUser, ids.inst, open.id, { optionIndex: 0, comment: "ignored — comments are off" });
      const res = await s.forms.getFormResults(teacherActor("classT"), open.id);
      expect(res.students.find((r) => r.studentId === ids.sA)?.comment).toBeNull();
      await s.forms.closeForm(teacherActor("classT"), open.id);
      await expect(s.forms.respondToForm(ids.sA2User, ids.inst, open.id, { optionIndex: 1 })).rejects.toThrow(/closed/);
    }));

  it("an admin can send school-wide and sees every form; a teacher sees only their own", () =>
    inCtx(async () => {
      const all = await s.forms.createForm(adminActor(), { kind: "SLIP", title: "Annual day photos", allowComment: true, allDivisions: true });
      expect(all.audience).toBe(3);
      expect((await s.forms.listFormsForStudent(ids.sBUser, ids.inst)).forms.map((f) => f.id)).toContain(all.id);

      const adminList = await s.forms.listFormsForCreator(adminActor());
      expect(adminList.map((f) => f.id)).toContain(all.id);
      expect(adminList.map((f) => f.id)).toContain(ids.slip);
      const teacherList = await s.forms.listFormsForCreator(teacherActor("otherT"));
      expect(teacherList.map((f) => f.id)).not.toContain(ids.slip);
    }));

  // ── Reminders ──────────────────────────────────────────────────────────────

  const reminded = async (title: string) =>
    (await s.prisma.notificationRecipient.findMany({ where: { institutionId: ids.inst, notification: { title: `Reminder: ${title}` } }, select: { userId: true } }))
      .map((r) => r.userId)
      .sort();

  it("reminds only parents who have not answered, and throttles repeats", () =>
    inCtx(async () => {
      const f = await s.forms.createForm(teacherActor("classT"), { kind: "POLL", title: "Remind me", options: ["A", "B"], allowComment: false });
      await s.forms.respondToForm(ids.sAUser, ids.inst, f.id, { optionIndex: 0 });

      await expect(s.forms.remindNonResponders(teacherActor("otherT"), f.id)).rejects.toThrow(/not found/i);
      expect(await s.forms.remindNonResponders(teacherActor("classT"), f.id)).toEqual({ reminded: 1 });
      expect(await reminded("Remind me")).toEqual([ids.sA2User]);

      await expect(s.forms.remindNonResponders(teacherActor("classT"), f.id)).rejects.toThrow(/recently/);
      await s.forms.closeForm(teacherActor("classT"), f.id);
      await expect(s.forms.remindNonResponders(teacherActor("classT"), f.id)).rejects.toThrow(/closed/);
    }));

  it("sends the automatic reminder once, only inside the 24h window", () =>
    inCtx(async () => {
      const soon = await s.forms.createForm(teacherActor("classT"), { kind: "SLIP", title: "Soon slip", allowComment: false, deadline: new Date(Date.now() + 3 * 60 * 60 * 1000) });
      const later = await s.forms.createForm(teacherActor("classT"), { kind: "SLIP", title: "Later slip", allowComment: false, deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) });
      await s.forms.respondToForm(ids.sA2User, ids.inst, soon.id, { optionIndex: 0 });

      await s.forms.sendAutomaticFormReminders();
      expect(await reminded("Soon slip")).toEqual([ids.sAUser]);
      expect(await reminded("Later slip")).toEqual([]);

      await s.forms.sendAutomaticFormReminders(); // second run must not resend
      expect(await reminded("Soon slip")).toEqual([ids.sAUser]);
      expect((await s.prisma.parentForm.findUnique({ where: { id: later.id } }))?.reminderSentAt).toBeNull();
    }));

  // ── PTM scheduler ──────────────────────────────────────────────────────────

  it("validates meeting sessions", () =>
    inCtx(async () => {
      const base = { title: "PTM", date: tomorrow(), startTime: "10:00", endTime: "11:00", slotMinutes: 20 };
      await expect(s.ptm.createSession(ids.classTUser, ids.inst, { ...base, date: "2020-01-01" })).rejects.toThrow(/future/);
      await expect(s.ptm.createSession(ids.classTUser, ids.inst, { ...base, endTime: "09:00" })).rejects.toThrow(/after the start/);
      await expect(s.ptm.createSession(ids.classTUser, ids.inst, { ...base, startTime: "00:00", endTime: "23:00", slotMinutes: 5 })).rejects.toThrow(/more than/);
    }));

  it("generates slots and shows them only to students of that teacher", () =>
    inCtx(async () => {
      const created = await s.ptm.createSession(ids.classTUser, ids.inst, { title: "Term 1 PTM", date: tomorrow(), startTime: "10:00", endTime: "11:00", slotMinutes: 20, location: "Room 4" });
      ids.session = created.id;
      expect(created.slots).toBe(3);

      const a = await s.ptm.listSessionsForStudent(ids.sAUser, ids.inst);
      expect(a.sessions).toHaveLength(1);
      expect(a.sessions[0].freeSlots).toBe(3);
      ids.slot1 = a.sessions[0].slots[0].id;
      ids.slot2 = a.sessions[0].slots[1].id;
      expect((await s.ptm.listSessionsForStudent(ids.sBUser, ids.inst)).sessions).toHaveLength(0);
    }));

  it("books a slot once per session and never double-books a slot", () =>
    inCtx(async () => {
      await s.ptm.bookSlot(ids.sAUser, ids.inst, ids.slot1);
      await expect(s.ptm.bookSlot(ids.sAUser, ids.inst, ids.slot2)).rejects.toThrow(/already have a slot/);
      await expect(s.ptm.bookSlot(ids.sA2User, ids.inst, ids.slot1)).rejects.toThrow(/took that slot/);
      await expect(s.ptm.bookSlot(ids.sBUser, ids.inst, ids.slot2)).rejects.toThrow(/child's teachers/);

      const view = await s.ptm.listSessionsForStudent(ids.sA2User, ids.inst);
      const slot = view.sessions[0].slots.find((x) => x.id === ids.slot1);
      expect(slot).toMatchObject({ free: false, mine: false }); // other parents' bookings stay private
    }));

  it("shows the teacher who booked which slot", () =>
    inCtx(async () => {
      const list = await s.ptm.listSessionsForTeacher(ids.classTUser, ids.inst);
      const slot = list[0].slots.find((x) => x.id === ids.slot1);
      expect(slot?.student?.id).toBe(ids.sA);
      expect(list[0].booked).toBe(1);
    }));

  it("lets a parent cancel early but not within 2 hours of the slot", () =>
    inCtx(async () => {
      await s.ptm.cancelBooking(ids.sAUser, ids.inst, ids.slot1);
      await s.ptm.bookSlot(ids.sAUser, ids.inst, ids.slot1);

      const istNow = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      const [h, m] = istNow.split(":").map(Number);
      const nowMinute = h * 60 + m;
      if (nowMinute < 22 * 60) {
        await s.prisma.ptmSession.update({ where: { id: ids.session }, data: { date: new Date(`${s.ptm.istDateString()}T00:00:00.000Z`) } });
        await s.prisma.ptmSlot.update({ where: { id: ids.slot1 }, data: { startMinute: nowMinute + 30, endMinute: nowMinute + 50 } });
        await expect(s.ptm.cancelBooking(ids.sAUser, ids.inst, ids.slot1)).rejects.toThrow(/2 hours/);
        await s.prisma.ptmSession.update({ where: { id: ids.session }, data: { date: new Date(`${tomorrow()}T00:00:00.000Z`) } });
        await s.prisma.ptmSlot.update({ where: { id: ids.slot1 }, data: { startMinute: 600, endMinute: 620 } });
      }
    }));

  it("lets the teacher release a booking, then cancel the whole session", () =>
    inCtx(async () => {
      await s.ptm.releaseSlot(ids.classTUser, ids.inst, ids.slot1);
      expect((await s.ptm.listSessionsForTeacher(ids.classTUser, ids.inst))[0].booked).toBe(0);
      await expect(s.ptm.releaseSlot(ids.otherTUser, ids.inst, ids.slot1)).rejects.toThrow(/not found/i);

      await s.ptm.bookSlot(ids.sA2User, ids.inst, ids.slot1);
      const adminView = await s.ptm.listSessionsForAdmin(ids.inst);
      expect(adminView.find((x) => x.id === ids.session)).toMatchObject({ totalSlots: 3, booked: 1 });

      await s.ptm.cancelSession(ids.classTUser, ids.inst, ids.session);
      expect((await s.ptm.listSessionsForStudent(ids.sA2User, ids.inst)).sessions).toHaveLength(0);
      await expect(s.ptm.bookSlot(ids.sAUser, ids.inst, ids.slot2)).rejects.toThrow(/not found/i);
    }));
});
