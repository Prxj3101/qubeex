import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { computeDefaultAcademicYearWindow } from "../../utils/academicYear";

describe("GET /api/admin/campus/divisions/:divisionId/students/:studentId/stats — subjects parity", () => {
  let institutionId: string;
  let academicYearId: string;
  let divisionId: string;
  let studentId: string;
  let adminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-STATS-${suffix}`,
        name: `Test Institution Stats ${suffix}`,
        email: `test-stats-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const academicYear = await prisma.academicYear.create({
      data: { institutionId, ...computeDefaultAcademicYearWindow(), isCurrent: true, status: "ACTIVE" },
    });
    academicYearId = academicYear.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class Stats ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    divisionId = division.id;

    const subject = await prisma.subject.create({
      data: { institutionId, standardId: standard.id, name: "Maths", order: 1 },
    });

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-stats-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const teacherUser = await prisma.user.create({
      data: { name: "Creator Teacher", email: `teacher-stats-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({
      data: { teacherId: `TCH-STATS-${suffix}`, userId: teacherUser.id, institutionId },
    });

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-stats-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STU-STATS-${suffix}`, userId: studentUser.id, institutionId, standardId: standard.id, divisionId, rollNo: "1" },
    });
    studentId = student.id;

    const marksheet = await prisma.marksheet.create({
      data: {
        institutionId, divisionId, createdByTeacherId: teacher.id,
        academicYearId, status: "PUBLISHED", shareToken: `share-${suffix}`,
      },
    });
    const column = await prisma.marksheetExamColumn.create({
      data: {
        marksheetId: marksheet.id, institutionId, subjectId: subject.id, createdByTeacherId: teacher.id,
        name: "Unit Test 1", maxMarks: 50, order: 1,
      },
    });
    await prisma.marksheetScore.create({
      data: { marksheetId: marksheet.id, institutionId, studentId, examColumnId: column.id, score: 40, isAbsent: false, enteredByTeacherId: teacher.id },
    });
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.marksheetScore.deleteMany({ where: { institutionId } });
    await prisma.marksheetExamColumn.deleteMany({ where: { institutionId } });
    await prisma.marksheet.deleteMany({ where: { institutionId } });
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

  it("includes a per-subject breakdown, matching teacher's existing endpoint shape", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/students/${studentId}/stats`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.subjects).toHaveLength(1);
    expect(res.body.data.subjects[0]).toMatchObject({ name: "Maths", scored: 40, max: 50, pct: 80 });
    expect(res.body.data.score.pct).toBe(80);
    expect(res.body.data.classRank).toBe(1);
  });
});
