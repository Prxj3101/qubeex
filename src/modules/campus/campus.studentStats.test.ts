import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("GET /admin/campus/divisions/:divisionId/students/:studentId/stats", () => {
  let institutionId: string;
  let divisionId: string;
  let studentAId: string;
  let studentBId: string;
  let adminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-SS-${suffix}`,
        name: `Test Institution SS ${suffix}`,
        email: `test-ss-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class SS ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    divisionId = division.id;

    const subject = await prisma.subject.create({
      data: { institutionId, standardId: standard.id, name: "Maths", order: 1 },
    });

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-ss-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const teacherUser = await prisma.user.create({
      data: { name: "Test Teacher", email: `teacher-ss-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({
      data: { teacherId: `TCH-SS-${suffix}`, userId: teacherUser.id, institutionId },
    });

    const studentAUser = await prisma.user.create({
      data: { name: "Student A", email: `student-a-ss-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const studentA = await prisma.student.create({
      data: { studentId: `STD-SSA-${suffix}`, userId: studentAUser.id, institutionId, divisionId, standardId: standard.id, rollNo: "01" },
    });
    studentAId = studentA.id;

    const studentBUser = await prisma.user.create({
      data: { name: "Student B", email: `student-b-ss-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const studentB = await prisma.student.create({
      data: { studentId: `STD-SSB-${suffix}`, userId: studentBUser.id, institutionId, divisionId, standardId: standard.id, rollNo: "02" },
    });
    studentBId = studentB.id;

    const marksheet = await prisma.marksheet.create({
      data: {
        institutionId, divisionId, createdByTeacherId: teacher.id,
        academicYear: "2025-26", status: "PUBLISHED", shareToken: `share-ss-${suffix}`,
      },
    });
    const column = await prisma.marksheetExamColumn.create({
      data: { marksheetId: marksheet.id, subjectId: subject.id, institutionId, name: "Unit Test", maxMarks: 100, createdByTeacherId: teacher.id },
    });

    // Student A scores 80/100 (higher), Student B scores 40/100 — A should rank #1
    await prisma.marksheetScore.create({
      data: { marksheetId: marksheet.id, examColumnId: column.id, studentId: studentAId, institutionId, score: 80, enteredByTeacherId: teacher.id },
    });
    await prisma.marksheetScore.create({
      data: { marksheetId: marksheet.id, examColumnId: column.id, studentId: studentBId, institutionId, score: 40, enteredByTeacherId: teacher.id },
    });

    // Attendance for Student A: 3 present, 1 absent → 75%
    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];
    const statuses = ["P", "P", "P", "A"];
    for (let i = 0; i < days.length; i++) {
      await prisma.attendance.create({
        data: { institutionId, divisionId, studentId: studentAId, date: days[i], status: statuses[i] },
      });
    }
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.attendance.deleteMany({ where: { institutionId } });
    await prisma.marksheetScore.deleteMany({ where: { institutionId } });
    await prisma.marksheetExamColumn.deleteMany({ where: { institutionId } });
    await prisma.marksheet.deleteMany({ where: { institutionId } });
    await prisma.subject.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("returns rank #1, score 80%, attendance 75% for the top-scoring student", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/students/${studentAId}/stats`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.classRank).toBe(1);
    expect(res.body.data.score.pct).toBe(80);
    expect(res.body.data.attendance).toEqual({ present: 3, total: 4, pct: 75 });
  });

  it("returns rank #2 and score 40% for the lower-scoring student, with no attendance records", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/students/${studentBId}/stats`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.classRank).toBe(2);
    expect(res.body.data.score.pct).toBe(40);
    expect(res.body.data.attendance).toEqual({ present: 0, total: 0, pct: null });
  });

  it("404s for a student id that doesn't belong to this division", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/students/00000000-0000-0000-0000-000000000000/stats`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });
});
