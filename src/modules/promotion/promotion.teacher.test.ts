import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Teacher promotion routes", () => {
  let institutionId: string;
  let standard5Id: string;
  let standard6Id: string;
  let division5AId: string;
  let division6AId: string;
  let teacherToken: string;
  let subjectTeacherToken: string;
  let studentAId: string;
  let studentBId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-PROMO-${suffix}`,
        name: `Test Institution Promo ${suffix}`,
        email: `test-promo-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard5 = await prisma.standard.create({ data: { institutionId, name: `Class 5 ${suffix}`, order: 5 } });
    const standard6 = await prisma.standard.create({ data: { institutionId, name: `Class 6 ${suffix}`, order: 6 } });
    standard5Id = standard5.id;
    standard6Id = standard6.id;

    const division5A = await prisma.division.create({ data: { standardId: standard5Id, institutionId, name: "A", capacity: 2 } });
    const division6A = await prisma.division.create({ data: { standardId: standard6Id, institutionId, name: "A" } });
    division5AId = division5A.id;
    division6AId = division6A.id;

    const teacherUser = await prisma.user.create({
      data: { name: "Class Teacher", email: `teacher-promo-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({ data: { teacherId: `TCH-PROMO-${suffix}`, userId: teacherUser.id, institutionId } });
    await prisma.divisionAssignment.create({ data: { divisionId: division5AId, subjectId: null, teacherId: teacher.id, institutionId } });
    teacherToken = jwt.sign({ userId: teacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const subjectTeacherUser = await prisma.user.create({
      data: { name: "Subject Teacher", email: `subj-promo-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const subjectTeacher = await prisma.teacher.create({ data: { teacherId: `TCH-PROMO-2-${suffix}`, userId: subjectTeacherUser.id, institutionId } });
    const subject = await prisma.subject.create({ data: { institutionId, standardId: standard5Id, name: "Maths", order: 1 } });
    await prisma.divisionAssignment.create({ data: { divisionId: division5AId, subjectId: subject.id, teacherId: subjectTeacher.id, institutionId } });
    subjectTeacherToken = jwt.sign({ userId: subjectTeacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const studentUserA = await prisma.user.create({
      data: { name: "Student A", email: `student-a-promo-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const studentA = await prisma.student.create({
      data: { studentId: `STU-A-${suffix}`, userId: studentUserA.id, institutionId, standardId: standard5Id, divisionId: division5AId, rollNo: "1" },
    });
    studentAId = studentA.id;

    const studentUserB = await prisma.user.create({
      data: { name: "Student B", email: `student-b-promo-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const studentB = await prisma.student.create({
      data: { studentId: `STU-B-${suffix}`, userId: studentUserB.id, institutionId, standardId: standard5Id, divisionId: division5AId, rollNo: "2" },
    });
    studentBId = studentB.id;
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.studentPromotionOutcome.deleteMany({ where: { institutionId } });
    await prisma.promotionBatch.deleteMany({ where: { institutionId } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.subject.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("class teacher sees the preview with next-standard targets", async () => {
    const res = await request(app)
      .get(`/api/teacher/promotions/divisions/${division5AId}/preview`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.students).toHaveLength(2);
    expect(res.body.data.isHighestStandard).toBe(false);
    expect(res.body.data.targets).toEqual([
      expect.objectContaining({ divisionId: division6AId, name: "A" }),
    ]);
  });

  it("rejects a subject teacher (not the class teacher)", async () => {
    const res = await request(app)
      .get(`/api/teacher/promotions/divisions/${division5AId}/preview`)
      .set("Authorization", `Bearer ${subjectTeacherToken}`);
    expect(res.status).toBe(403);
  });

  let createdBatchId: string;

  it("promotes one student and repeats the other, then reflects it in a re-fetched preview", async () => {
    const res = await request(app)
      .post(`/api/teacher/promotions/divisions/${division5AId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({
        outcomes: [
          { studentId: studentAId, outcome: "PROMOTED" },
          { studentId: studentBId, outcome: "REPEATED" },
        ],
        targetDivisionId: division6AId,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.batchId).toBeTruthy();
    createdBatchId = res.body.data.batchId;

    const studentA = await prisma.student.findUnique({ where: { id: studentAId } });
    expect(studentA?.divisionId).toBe(division6AId);
    expect(studentA?.standardId).toBe(standard6Id);

    const studentB = await prisma.student.findUnique({ where: { id: studentBId } });
    expect(studentB?.divisionId).toBe(division5AId);

    const preview = await request(app)
      .get(`/api/teacher/promotions/divisions/${division5AId}/preview`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(preview.body.data.students).toHaveLength(1);
    expect(preview.body.data.students[0].id).toBe(studentBId);
  });

  it("lists the batch in history with correct counts", async () => {
    const res = await request(app)
      .get(`/api/teacher/promotions/batches?divisionId=${division5AId}`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      id: createdBatchId,
      counts: { promoted: 1, repeated: 1, graduated: 0, withdrawn: 0 },
    });
  });

  it("undoes the batch and restores student A to the original division", async () => {
    const res = await request(app)
      .post(`/api/teacher/promotions/batches/${createdBatchId}/undo`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);

    const studentA = await prisma.student.findUnique({ where: { id: studentAId } });
    expect(studentA?.divisionId).toBe(division5AId);
    expect(studentA?.standardId).toBe(standard5Id);
  });

  it("rejects undoing an already-undone batch", async () => {
    const res = await request(app)
      .post(`/api/teacher/promotions/batches/${createdBatchId}/undo`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(res.status).toBe(409);
  });
});
