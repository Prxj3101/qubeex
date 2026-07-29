import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Teacher — updating a student's email", () => {
  let institutionId: string;
  let divisionId: string;
  let teacherToken: string;
  let studentId: string;
  let otherStudentEmail: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-EMAIL-${suffix}`,
        name: `Test Institution Email ${suffix}`,
        email: `test-email-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({ data: { institutionId, name: `Class ${suffix}`, order: 1 } });
    const division = await prisma.division.create({ data: { standardId: standard.id, institutionId, name: "A" } });
    divisionId = division.id;

    const teacherUser = await prisma.user.create({
      data: { name: "Class Teacher", email: `teacher-email-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({ data: { teacherId: `TCH-EMAIL-${suffix}`, userId: teacherUser.id, institutionId } });
    await prisma.divisionAssignment.create({ data: { divisionId, subjectId: null, teacherId: teacher.id, institutionId } });
    teacherToken = jwt.sign({ userId: teacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    // Placeholder-style auto-generated email, same shape the create endpoint
    // generates when the teacher leaves the email field blank.
    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `stuemail${suffix}@students.qubeex.local`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STU-EMAIL-${suffix}`, userId: studentUser.id, institutionId, standardId: standard.id, divisionId, rollNo: "1" },
    });
    studentId = student.id;

    const otherUser = await prisma.user.create({
      data: { name: "Other Student", email: `other-email-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    await prisma.student.create({
      data: { studentId: `STU-OTHER-${suffix}`, userId: otherUser.id, institutionId, standardId: standard.id, divisionId, rollNo: "2" },
    });
    otherStudentEmail = otherUser.email;
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("replaces the auto-generated placeholder email with a real one and persists it", async () => {
    const res = await request(app)
      .patch(`/api/teacher/classes/${divisionId}/students/${studentId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ email: "real.student@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe("real.student@example.com");

    const persisted = await prisma.student.findFirst({ where: { id: studentId }, include: { user: { select: { email: true } } } });
    expect(persisted?.user.email).toBe("real.student@example.com");
  });

  it("rejects an invalid email format", async () => {
    const res = await request(app)
      .patch(`/api/teacher/classes/${divisionId}/students/${studentId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("rejects an email already used by another user", async () => {
    const res = await request(app)
      .patch(`/api/teacher/classes/${divisionId}/students/${studentId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ email: otherStudentEmail });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/i);
  });
});
