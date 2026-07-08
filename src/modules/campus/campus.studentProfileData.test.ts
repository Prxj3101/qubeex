import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Student marksheet + attendance-trend (teacher + admin)", () => {
  let institutionId: string;
  let divisionId: string;
  let studentId: string;
  let adminToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-PROF-${suffix}`,
        name: `Test Institution Prof ${suffix}`,
        email: `test-prof-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class Prof ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    divisionId = division.id;

    const subject = await prisma.subject.create({
      data: { institutionId, standardId: standard.id, name: "Science", order: 1 },
    });

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-prof-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const teacherUser = await prisma.user.create({
      data: { name: "Test Teacher", email: `teacher-prof-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({
      data: { teacherId: `TCH-PROF-${suffix}`, userId: teacherUser.id, institutionId },
    });
    await prisma.divisionAssignment.create({
      data: { divisionId, subjectId: null, teacherId: teacher.id, institutionId },
    });
    teacherToken = jwt.sign({ userId: teacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-prof-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STU-PROF-${suffix}`, userId: studentUser.id, institutionId, standardId: standard.id, divisionId, rollNo: "1" },
    });
    studentId = student.id;

    const marksheet = await prisma.marksheet.create({
      data: {
        institutionId, divisionId, createdByTeacherId: teacher.id,
        academicYear: "2026-2027", status: "PUBLISHED", shareToken: `share-prof-${suffix}`,
      },
    });
    const column = await prisma.marksheetExamColumn.create({
      data: {
        marksheetId: marksheet.id, institutionId, subjectId: subject.id, createdByTeacherId: teacher.id,
        name: "Unit Test 1", maxMarks: 100, order: 1,
      },
    });
    await prisma.marksheetScore.create({
      data: { marksheetId: marksheet.id, institutionId, studentId, examColumnId: column.id, score: 90, isAbsent: false, enteredByTeacherId: teacher.id },
    });

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    await prisma.attendance.create({
      data: { institutionId, divisionId, studentId, date: todayStr, status: "P" },
    });
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.attendance.deleteMany({ where: { institutionId } });
    await prisma.marksheetScore.deleteMany({ where: { institutionId } });
    await prisma.marksheetExamColumn.deleteMany({ where: { institutionId } });
    await prisma.marksheet.deleteMany({ where: { institutionId } });
    await prisma.subject.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("teacher can fetch marksheet breakdown", async () => {
    const res = await request(app)
      .get(`/api/teacher/classes/${divisionId}/students/${studentId}/marksheet`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.subjects).toHaveLength(1);
    expect(res.body.data.subjects[0]).toMatchObject({ name: "Science", pct: 90, total: { scored: 90, max: 100 } });
    expect(res.body.data.grandPct).toBe(90);
    expect(res.body.data.classRank).toBe(1);
  });

  it("admin can fetch marksheet breakdown (same shape)", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/students/${studentId}/marksheet`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.subjects[0].total).toMatchObject({ scored: 90, max: 100 });
  });

  it("teacher can fetch attendance trend with today's record reflected in overall", async () => {
    const res = await request(app)
      .get(`/api/teacher/classes/${divisionId}/students/${studentId}/attendance-trend`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.overall.pct).toBe(100);
    expect(res.body.data.monthly).toHaveLength(12);
  });

  it("admin can fetch attendance trend (same shape)", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/students/${studentId}/attendance-trend`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.overall.pct).toBe(100);
  });
});
