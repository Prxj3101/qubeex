/**
 * Service tests against a REAL Postgres. Skipped unless PARENT_CHAT_TEST_DATABASE_URL is set,
 * and refuses to run against anything that is not localhost (these tests create and delete rows).
 *
 *   docker run -d --rm --name qx-chat-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=qx -p 5545:5432 postgres:16
 *   (apply schema: prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script | psql ...)
 *   PARENT_CHAT_TEST_DATABASE_URL=postgresql://postgres:test@localhost:5545/qx npx jest parentChat.integration
 */
export {};

const URL_ = process.env.PARENT_CHAT_TEST_DATABASE_URL;
const enabled = !!URL_ && /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
const d = enabled ? describe : describe.skip;

type Svc = {
  prisma: typeof import("../../utils/prisma").prisma;
  run: typeof import("../../utils/academicContext").runWithAcademicClient;
  chat: typeof import("../../services/parentChat.service");
};
let s: Svc;

d("Parent ↔ teacher chat (integration)", () => {
  const ids: Record<string, string> = {};
  const inCtx = <T>(fn: () => Promise<T>) => s.run(s.prisma, fn);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_;
    const [prismaMod, ctxMod, chat] = await Promise.all([
      import("../../utils/prisma"),
      import("../../utils/academicContext"),
      import("../../services/parentChat.service"),
    ]);
    s = { prisma: prismaMod.prisma, run: ctxMod.runWithAcademicClient, chat };
    const p = s.prisma;
    const tag = `pc${Date.now()}`;

    const mkInst = (n: string) =>
      p.institution.create({ data: { institutionCode: `${tag}${n}`, name: `Inst ${n}`, email: `${tag}${n}@x.test`, type: "SCHOOL", status: "ACTIVE" } });
    const inst = await mkInst("A");
    const other = await mkInst("B");
    ids.inst = inst.id;
    ids.other = other.id;

    const mkUser = (n: string, role: "ADMIN" | "TEACHER" | "STUDENT", institutionId: string) =>
      p.user.create({ data: { name: n, email: `${tag}${n.replace(/\W/g, "")}@x.test`, role, institutionId, isActive: true } });
    ids.adminUser = (await mkUser("Admin", "ADMIN", inst.id)).id;

    await p.academicYear.create({ data: { institutionId: inst.id, label: "2026-27", startDate: new Date("2026-06-01"), endDate: new Date("2027-05-31"), isCurrent: true, status: "ACTIVE" } });
    const year = await p.academicYear.findFirstOrThrow({ where: { institutionId: inst.id } });

    const std = await p.standard.create({ data: { institutionId: inst.id, name: "10", order: 10 } });
    const divA = await p.division.create({ data: { institutionId: inst.id, standardId: std.id, name: "A" } });
    const divB = await p.division.create({ data: { institutionId: inst.id, standardId: std.id, name: "B" } });
    const maths = await p.subject.create({ data: { institutionId: inst.id, standardId: std.id, name: "Mathematics", order: 1 } });

    const mkTeacher = async (key: string, name: string) => {
      const u = await mkUser(name, "TEACHER", inst.id);
      const t = await p.teacher.create({ data: { teacherId: `${tag}-${key}`, userId: u.id, institutionId: inst.id } });
      ids[key] = t.id;
      ids[`${key}User`] = u.id;
    };
    await mkTeacher("classT", "ClassTeacher");
    await mkTeacher("mathsT", "MathsTeacher");
    await mkTeacher("otherDivT", "OtherDivTeacher");
    await p.division.update({ where: { id: divA.id }, data: { classTeacherId: ids.classT } });
    await p.divisionAssignment.create({ data: { divisionId: divA.id, subjectId: maths.id, teacherId: ids.mathsT, institutionId: inst.id, academicYearId: year.id } });
    await p.divisionAssignment.create({ data: { divisionId: divB.id, subjectId: maths.id, teacherId: ids.otherDivT, institutionId: inst.id, academicYearId: year.id } });

    const stuUser = await mkUser("Stu", "STUDENT", inst.id);
    const stu = await p.student.create({ data: { studentId: `${tag}-s`, userId: stuUser.id, institutionId: inst.id, standardId: std.id, divisionId: divA.id } });
    ids.stu = stu.id;
    ids.stuUser = stuUser.id;
  });

  afterAll(async () => {
    if (!s) return;
    const p = s.prisma;
    for (const id of [ids.inst, ids.other]) {
      if (!id) continue; // never deleteMany with an undefined institutionId — Prisma treats it as "no filter"
      await p.parentChatMessage.deleteMany({ where: { institutionId: id } });
      await p.parentChatThread.deleteMany({ where: { institutionId: id } });
      await p.parentChatSettings.deleteMany({ where: { institutionId: id } });
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
    }
    await p.$disconnect();
  });

  it("lists only the class teacher and subject teachers of the student's own division", () =>
    inCtx(async () => {
      const { contacts } = await s.chat.listContactsForStudent(ids.stuUser, ids.inst);
      expect(contacts.map((c) => c.teacherId).sort()).toEqual([ids.classT, ids.mathsT].sort());
      expect(contacts.find((c) => c.teacherId === ids.classT)?.isClassTeacher).toBe(true);
      expect(contacts.find((c) => c.teacherId === ids.mathsT)?.subjects).toEqual(["Mathematics"]);
    }));

  it("rejects a message to a teacher of another division", () =>
    inCtx(async () => {
      await expect(s.chat.sendMessageFromStudent(ids.stuUser, ids.inst, ids.otherDivT, { text: "hi" })).rejects.toThrow(/own class/);
    }));

  it("round-trips a message and tracks unread on both sides", () =>
    inCtx(async () => {
      await s.chat.sendMessageFromStudent(ids.stuUser, ids.inst, ids.classT, { text: "Hello teacher" });
      expect(await s.chat.unreadCountForTeacher(ids.classTUser, ids.inst)).toBe(1);

      const { threads } = await s.chat.listThreadsForTeacher(ids.classTUser, ids.inst);
      expect(threads).toHaveLength(1);
      expect(threads[0].unread).toBe(1);
      ids.thread = threads[0].id;

      await s.chat.markReadForTeacher(ids.classTUser, ids.inst, ids.thread);
      expect(await s.chat.unreadCountForTeacher(ids.classTUser, ids.inst)).toBe(0);

      await s.chat.sendMessageFromTeacher(ids.classTUser, ids.inst, ids.thread, { text: "Hello parent" });
      expect(await s.chat.unreadCountForStudent(ids.stuUser, ids.inst)).toBe(1);

      const { messages } = await s.chat.getMessagesForStudent(ids.stuUser, ids.inst, ids.classT, {});
      expect(messages.map((m) => m.text)).toEqual(["Hello teacher", "Hello parent"]);

      await s.chat.markReadForStudent(ids.stuUser, ids.inst, ids.classT);
      expect(await s.chat.unreadCountForStudent(ids.stuUser, ids.inst)).toBe(0);
    }));

  it("a teacher outside the thread cannot read it", () =>
    inCtx(async () => {
      await expect(s.chat.getMessagesForTeacher(ids.mathsTUser, ids.inst, ids.thread, {})).rejects.toThrow(/not found/i);
    }));

  it("the other institution's admin cannot see the thread", () =>
    inCtx(async () => {
      await expect(s.chat.getThreadForAdmin(ids.other, ids.thread)).rejects.toThrow(/not found/i);
    }));

  it("hidden messages are blanked for participants but visible to admin", () =>
    inCtx(async () => {
      const { messages } = await s.chat.getMessagesForStudent(ids.stuUser, ids.inst, ids.classT, {});
      await s.chat.hideMessage(ids.inst, messages[0].id, ids.adminUser);

      const after = await s.chat.getMessagesForStudent(ids.stuUser, ids.inst, ids.classT, {});
      expect(after.messages[0]).toMatchObject({ hidden: true, text: "" });

      const adminView = await s.chat.getThreadForAdmin(ids.inst, ids.thread);
      expect(adminView.messages[0].text).toBe("Hello teacher");
    }));

  it("blocks sending when the school turns chat off", () =>
    inCtx(async () => {
      await s.chat.saveChatSettings(ids.inst, { enabled: false, officeStart: "08:00", officeEnd: "18:00" });
      await expect(s.chat.sendMessageFromStudent(ids.stuUser, ids.inst, ids.classT, { text: "x" })).rejects.toThrow(/turned off/);
      await s.chat.saveChatSettings(ids.inst, { enabled: true, officeStart: "08:00", officeEnd: "18:00" });
    }));

  it("rejects an attachment that was not uploaded through this institution's parent-chat upload", () =>
    inCtx(async () => {
      await expect(
        s.chat.sendMessageFromStudent(ids.stuUser, ids.inst, ids.classT, {
          attachment: { url: "https://evil.example.com/x.pdf", type: "pdf", name: "x.pdf" },
        })
      ).rejects.toThrow(/Invalid attachment/);
    }));

  it("rejects an upload whose bytes are not a photo or PDF, whatever the client claims", async () => {
    await expect(s.chat.uploadChatAttachment(Buffer.from("MZ not an image"), "photo.jpg", ids.inst)).rejects.toThrow(/Only photos/);
  });

  it("rejects an empty message with no attachment", () =>
    inCtx(async () => {
      await expect(s.chat.sendMessageFromStudent(ids.stuUser, ids.inst, ids.classT, { text: "  " })).rejects.toThrow(/empty/);
    }));

  it("lets a parent report a teacher message, but not their own or a stranger's", () =>
    inCtx(async () => {
      const { messages } = await s.chat.getMessagesForStudent(ids.stuUser, ids.inst, ids.classT, {});
      const fromTeacher = messages.find((m) => m.fromTeacher);
      const fromParent = messages.find((m) => !m.fromTeacher);
      expect(fromTeacher && fromParent).toBeTruthy();

      await expect(s.chat.reportMessage(ids.stuUser, ids.inst, fromParent!.id, "student")).rejects.toThrow(/sent to you/);
      await expect(s.chat.reportMessage(ids.mathsTUser, ids.inst, fromTeacher!.id, "teacher")).rejects.toThrow(/not found/i);

      await s.chat.reportMessage(ids.stuUser, ids.inst, fromTeacher!.id, "student", "rude");
      const after = await s.chat.getMessagesForStudent(ids.stuUser, ids.inst, ids.classT, {});
      expect(after.messages.find((m) => m.id === fromTeacher!.id)?.reportedByMe).toBe(true);
    }));

  it("floats reported threads to the top for the admin and exposes the reason", () =>
    inCtx(async () => {
      const list = await s.chat.listThreadsForAdmin(ids.inst);
      expect(list[0].id).toBe(ids.thread);
      expect(list[0].reportedCount).toBe(1);
      const detail = await s.chat.getThreadForAdmin(ids.inst, ids.thread);
      expect(detail.messages.some((m) => m.reportReason === "rude")).toBe(true);
    }));

  it("rate limits a burst of messages", () =>
    inCtx(async () => {
      const results: string[] = [];
      for (let i = 0; i < 12; i++) {
        results.push(await s.chat.sendMessageFromStudent(ids.stuUser, ids.inst, ids.mathsT, { text: `m${i}` }).then(() => "ok", (e: Error) => e.message));
      }
      expect(results.filter((r) => r === "ok").length).toBeLessThanOrEqual(10);
      expect(results.some((r) => r !== "ok" && /too quickly/.test(r))).toBe(true);
    }));
});
