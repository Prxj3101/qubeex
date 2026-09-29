import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { computeDefaultAcademicYearWindow } from "../../utils/academicYear";

describe("Teacher promotion routes", () => {
  let institutionId: string;
  let academicYearId: string;
  let standard5Id: string;
  let standard6Id: string;
  let division5AId: string;
  let division5BId: string;
  let division6AId: string;
  let teacherToken: string;
  let subjectTeacherToken: string;
  let studentAId: string;
  let studentBId: string;
  let studentCId: string;
  let studentDId: string;

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
    const academicYear = await prisma.academicYear.create({
      data: { institutionId, ...computeDefaultAcademicYearWindow(), isCurrent: true, status: "ACTIVE" },
    });
    academicYearId = academicYear.id;

    const standard5 = await prisma.standard.create({ data: { institutionId, name: `Class 5 ${suffix}`, order: 5 } });
    const standard6 = await prisma.standard.create({ data: { institutionId, name: `Class 6 ${suffix}`, order: 6 } });
    standard5Id = standard5.id;
    standard6Id = standard6.id;

    const division5A = await prisma.division.create({ data: { standardId: standard5Id, institutionId, name: "A", capacity: 2 } });
    const division5B = await prisma.division.create({ data: { standardId: standard5Id, institutionId, name: "B" } });
    const division6A = await prisma.division.create({ data: { standardId: standard6Id, institutionId, name: "A" } });
    division5AId = division5A.id;
    division5BId = division5B.id;
    division6AId = division6A.id;

    const teacherUser = await prisma.user.create({
      data: { name: "Class Teacher", email: `teacher-promo-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({ data: { teacherId: `TCH-PROMO-${suffix}`, userId: teacherUser.id, institutionId } });
    await prisma.divisionAssignment.create({ data: { academicYearId, divisionId: division5AId, subjectId: null, teacherId: teacher.id, institutionId } });
    await prisma.divisionAssignment.create({ data: { academicYearId, divisionId: division5BId, subjectId: null, teacherId: teacher.id, institutionId } });
    teacherToken = jwt.sign({ userId: teacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const subjectTeacherUser = await prisma.user.create({
      data: { name: "Subject Teacher", email: `subj-promo-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const subjectTeacher = await prisma.teacher.create({ data: { teacherId: `TCH-PROMO-2-${suffix}`, userId: subjectTeacherUser.id, institutionId } });
    const subject = await prisma.subject.create({ data: { institutionId, standardId: standard5Id, name: "Maths", order: 1 } });
    await prisma.divisionAssignment.create({ data: { academicYearId, divisionId: division5AId, subjectId: subject.id, teacherId: subjectTeacher.id, institutionId } });
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

    // Fresh students for the StudentEnrollment tests below — studentA/B already accrue
    // enrollment rows for the current academic year from the promotion test above, and
    // re-promoting them within the same year would hit the studentId+academicYearId unique
    // constraint on StudentEnrollment, which is not what those tests are probing.
    const studentUserC = await prisma.user.create({
      data: { name: "Student C", email: `student-c-promo-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const studentC = await prisma.student.create({
      data: { studentId: `STU-C-${suffix}`, userId: studentUserC.id, institutionId, standardId: standard5Id, divisionId: division5BId, rollNo: "1" },
    });
    studentCId = studentC.id;

    const studentUserD = await prisma.user.create({
      data: { name: "Student D", email: `student-d-promo-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const studentD = await prisma.student.create({
      data: { studentId: `STU-D-${suffix}`, userId: studentUserD.id, institutionId, standardId: standard5Id, divisionId: division5BId, rollNo: "2" },
    });
    studentDId = studentD.id;
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.studentEnrollment.deleteMany({ where: { institutionId } });
    await prisma.studentPromotionOutcome.deleteMany({ where: { institutionId } });
    await prisma.promotionBatch.deleteMany({ where: { institutionId } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.subject.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.academicYear.deleteMany({ where: { institutionId } });
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

  it("undo removes the StudentEnrollment row and allows a clean re-promotion in the same academic year", async () => {
    const currentYear = await prisma.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
    expect(currentYear).not.toBeNull();

    // The undo above should have deleted the StudentEnrollment row the original promotion created.
    const staleEnrollment = await prisma.studentEnrollment.findUnique({
      where: { studentId_academicYearId: { studentId: studentAId, academicYearId: currentYear!.id } },
    });
    expect(staleEnrollment).toBeNull();

    // Re-promoting studentA (now restored to division5A, ACTIVE) in the same academic year
    // should succeed cleanly — not 500 on a stale/duplicate StudentEnrollment row.
    const res = await request(app)
      .post(`/api/teacher/promotions/divisions/${division5AId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ outcomes: [{ studentId: studentAId, outcome: "PROMOTED" }], targetDivisionId: division6AId });
    expect(res.status).toBe(200);

    // PROMOTED students' enrollment belongs to the year AFTER the one being
    // closed out (currentYear), not currentYear itself.
    const nextWindow = computeDefaultAcademicYearWindow(new Date(currentYear!.endDate.getTime() + 24 * 60 * 60 * 1000));
    const nextYear = await prisma.academicYear.findFirst({ where: { institutionId, label: nextWindow.label } });
    expect(nextYear).not.toBeNull();

    const enrollment = await prisma.studentEnrollment.findUnique({
      where: { studentId_academicYearId: { studentId: studentAId, academicYearId: nextYear!.id } },
    });
    expect(enrollment).not.toBeNull();
    expect(enrollment!.divisionId).toBe(division6AId);
    expect(enrollment!.status).toBe("ACTIVE");
  });

  it("rejects undoing an already-undone batch", async () => {
    const res = await request(app)
      .post(`/api/teacher/promotions/batches/${createdBatchId}/undo`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(res.status).toBe(409);
  });

  it("creates a StudentEnrollment row for the current academic year on promotion", async () => {
    const currentYear = await prisma.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
    expect(currentYear).not.toBeNull();

    const res = await request(app)
      .post(`/api/teacher/promotions/divisions/${division5BId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ outcomes: [{ studentId: studentCId, outcome: "PROMOTED" }], targetDivisionId: division6AId });
    expect(res.status).toBe(200);

    const nextWindow = computeDefaultAcademicYearWindow(new Date(currentYear!.endDate.getTime() + 24 * 60 * 60 * 1000));
    const nextYear = await prisma.academicYear.findFirst({ where: { institutionId, label: nextWindow.label } });
    expect(nextYear).not.toBeNull();

    const enrollment = await prisma.studentEnrollment.findUnique({
      where: { studentId_academicYearId: { studentId: studentCId, academicYearId: nextYear!.id } },
    });
    expect(enrollment).not.toBeNull();
    expect(enrollment!.divisionId).toBe(division6AId);
    expect(enrollment!.status).toBe("ACTIVE");
  });

  it("fails cleanly, not with a crash, when promoting the same student twice in one year", async () => {
    await request(app)
      .post(`/api/teacher/promotions/divisions/${division5BId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ outcomes: [{ studentId: studentDId, outcome: "PROMOTED" }], targetDivisionId: division6AId });

    // Re-promoting studentD (now inactive in division5B) should 400, not 500,
    // because applyPromotionOutcomes only accepts ACTIVE students of the source division.
    const res = await request(app)
      .post(`/api/teacher/promotions/divisions/${division5BId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ outcomes: [{ studentId: studentDId, outcome: "PROMOTED" }], targetDivisionId: division6AId });
    expect(res.status).toBe(400);
  });

  it("returns 409, not a 500, when a REPEATED student is processed by a second batch in the same year", async () => {
    // A REPEATED student stays ACTIVE in the source division, so a second batch
    // for the same division in the same academic year reaches the
    // StudentEnrollment (studentId, academicYearId) unique constraint.
    const suffix = `${Date.now()}`;
    const studentUserE = await prisma.user.create({
      data: { name: "Student E", email: `student-e-promo-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const studentE = await prisma.student.create({
      data: { studentId: `STU-E-${suffix}`, userId: studentUserE.id, institutionId, standardId: standard5Id, divisionId: division5BId, rollNo: "3" },
    });

    const first = await request(app)
      .post(`/api/teacher/promotions/divisions/${division5BId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ outcomes: [{ studentId: studentE.id, outcome: "REPEATED" }] });
    expect(first.status).toBe(200);

    const batchesBefore = await prisma.promotionBatch.count({ where: { institutionId } });

    const second = await request(app)
      .post(`/api/teacher/promotions/divisions/${division5BId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ outcomes: [{ studentId: studentE.id, outcome: "REPEATED" }] });
    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);
    expect(second.body.error).toBe("This student already has an enrollment record for this academic year");

    // The whole second batch rolled back — no orphaned PromotionBatch row.
    const batchesAfter = await prisma.promotionBatch.count({ where: { institutionId } });
    expect(batchesAfter).toBe(batchesBefore);
  });
});
