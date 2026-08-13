// src/modules/teacher/teacher.remarks.test.ts
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("POST /api/teacher/classes/:divisionId/students/:studentId/remarks", () => {
  let institutionId: string;
  let divisionId: string;
  let otherDivisionId: string;
  let studentId: string;
  let teacherToken: string;
  let unassignedTeacherToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-RM-${suffix}`,
        name: `Test Institution RM ${suffix}`,
        email: `test-rm-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class RM ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    const otherDivision = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "B" },
    });
    divisionId = division.id;
    otherDivisionId = otherDivision.id;

    const teacherUser = await prisma.user.create({
      data: { name: "Test Teacher", email: `teacher-rm-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({
      data: { teacherId: `TCH-RM-${suffix}`, userId: teacherUser.id, institutionId },
    });
    await prisma.divisionAssignment.create({
      data: { divisionId, subjectId: null, teacherId: teacher.id, institutionId },
    });

    const unassignedTeacherUser = await prisma.user.create({
      data: { name: "Unassigned Teacher", email: `teacher-rm-2-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    await prisma.teacher.create({
      data: { teacherId: `TCH-RM-2-${suffix}`, userId: unassignedTeacherUser.id, institutionId },
    });

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-rm-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STU-RM-${suffix}`, userId: studentUser.id, institutionId, standardId: standard.id, divisionId, rollNo: "1" },
    });
    studentId = student.id;

    teacherToken = jwt.sign({ userId: teacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);
    unassignedTeacherToken = jwt.sign({ userId: unassignedTeacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.studentRemark.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("creates a report and returns it in the FlagItem-compatible shape", async () => {
    const res = await request(app)
      .post(`/api/teacher/classes/${divisionId}/students/${studentId}/remarks`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({
        severity: "LOW",
        category: "Late Submission",
        title: "Assignment submitted late",
        detail: "Submitted 2 days after deadline.",
        subject: "Maths",
        actionTaken: "Marks deducted.",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      type: "yellow",
      severity: "low",
      category: "Late Submission",
      title: "Assignment submitted late",
      detail: "Submitted 2 days after deadline.",
      subject: "Maths",
      reportedBy: "Test Teacher",
      role: "Faculty",
      status: "open",
      actionTaken: "Marks deducted.",
      // The class teacher (this same teacher, in this fixture) is assigned
      // automatically, and can therefore review their own submission.
      assignedToName: "Test Teacher",
      canReview: true,
    });
    expect(typeof res.body.data.date).toBe("string");
    expect(Number.isNaN(new Date(res.body.data.date).getTime())).toBe(false);
  });

  it("stores an explicit RED card with HIGH severity", async () => {
    const res = await request(app)
      .post(`/api/teacher/classes/${divisionId}/students/${studentId}/remarks`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ type: "RED", severity: "HIGH", category: "Misconduct", title: "T", detail: "D" });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("red");
    expect(res.body.data.severity).toBe("high");
  });

  it("rejects a teacher not assigned to the division", async () => {
    const res = await request(app)
      .post(`/api/teacher/classes/${divisionId}/students/${studentId}/remarks`)
      .set("Authorization", `Bearer ${unassignedTeacherToken}`)
      .send({ severity: "HIGH", category: "Test", title: "T", detail: "D" });

    expect(res.status).toBe(403);
  });

  it("rejects a student not in the given division", async () => {
    const res = await request(app)
      .post(`/api/teacher/classes/${otherDivisionId}/students/${studentId}/remarks`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ severity: "HIGH", category: "Test", title: "T", detail: "D" });

    expect(res.status).toBe(403);
  });
});
