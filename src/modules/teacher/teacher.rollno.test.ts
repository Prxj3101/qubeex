import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { computeDefaultAcademicYearWindow } from "../../utils/academicYear";

describe("Teacher — roll number uniqueness within a division", () => {
  let institutionId: string;
  let academicYearId: string;
  let divisionId: string;
  let otherDivisionId: string;
  let teacherToken: string;
  let existingStudentId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-ROLLNO-${suffix}`,
        name: `Test Institution RollNo ${suffix}`,
        email: `test-rollno-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const academicYear = await prisma.academicYear.create({
      data: { institutionId, ...computeDefaultAcademicYearWindow(), isCurrent: true, status: "ACTIVE" },
    });
    academicYearId = academicYear.id;

    const standard = await prisma.standard.create({ data: { institutionId, name: `Class ${suffix}`, order: 1 } });
    const division = await prisma.division.create({ data: { standardId: standard.id, institutionId, name: "A" } });
    divisionId = division.id;
    const otherDivision = await prisma.division.create({ data: { standardId: standard.id, institutionId, name: "B" } });
    otherDivisionId = otherDivision.id;

    const teacherUser = await prisma.user.create({
      data: { name: "Class Teacher", email: `teacher-rollno-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({ data: { teacherId: `TCH-ROLLNO-${suffix}`, userId: teacherUser.id, institutionId } });
    await prisma.divisionAssignment.create({ data: { academicYearId, divisionId, subjectId: null, teacherId: teacher.id, institutionId } });
    await prisma.divisionAssignment.create({ data: { academicYearId, divisionId: otherDivisionId, subjectId: null, teacherId: teacher.id, institutionId } });
    teacherToken = jwt.sign({ userId: teacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const existingStudentUser = await prisma.user.create({
      data: { name: "Existing Student", email: `student-existing-rollno-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const existingStudent = await prisma.student.create({
      data: { studentId: `STU-EXIST-${suffix}`, userId: existingStudentUser.id, institutionId, standardId: standard.id, divisionId, rollNo: "7" },
    });
    existingStudentId = existingStudent.id;
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.studentEnrollment.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.userStatusEvent.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.academicYear.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("rejects creating a student with a roll no already used in the same division", async () => {
    const res = await request(app)
      .post(`/api/teacher/classes/${divisionId}/students`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ name: "New Student", rollNo: "7" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already assigned/i);
  });

  it("allows creating a student with the same roll no in a different division", async () => {
    const res = await request(app)
      .post(`/api/teacher/classes/${otherDivisionId}/students`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ name: "New Student In Other Division", rollNo: "7" });
    expect(res.status).toBe(201);
  });

  it("allows creating a student with a unique roll no", async () => {
    const res = await request(app)
      .post(`/api/teacher/classes/${divisionId}/students`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ name: "Unique Roll Student", rollNo: "8" });
    expect(res.status).toBe(201);
  });

  it("rejects updating a student's roll no to one already taken in the division", async () => {
    const res = await request(app)
      .patch(`/api/teacher/classes/${divisionId}/students/${existingStudentId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ rollNo: "8" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already assigned/i);
  });

  it("allows updating a student to keep their own roll no unchanged", async () => {
    const res = await request(app)
      .patch(`/api/teacher/classes/${divisionId}/students/${existingStudentId}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ rollNo: "7" });
    expect(res.status).toBe(200);
  });
});
