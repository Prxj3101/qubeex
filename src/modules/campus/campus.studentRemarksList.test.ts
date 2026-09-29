import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { computeDefaultAcademicYearWindow } from "../../utils/academicYear";

describe("GET .../students/:studentId/remarks (list, teacher + admin)", () => {
  let institutionId: string;
  let academicYearId: string;
  let divisionId: string;
  let otherDivisionId: string;
  let studentId: string;
  let adminToken: string;
  let teacherToken: string;
  let unassignedTeacherToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-RMLIST-${suffix}`,
        name: `Test Institution RmList ${suffix}`,
        email: `test-rmlist-${suffix}@example.com`,
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
      data: { institutionId, name: `Class RmList ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    const otherDivision = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "B" },
    });
    divisionId = division.id;
    otherDivisionId = otherDivision.id;

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-rmlist-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const teacherUser = await prisma.user.create({
      data: { name: "Test Teacher", email: `teacher-rmlist-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({
      data: { teacherId: `TCH-RMLIST-${suffix}`, userId: teacherUser.id, institutionId },
    });
    await prisma.divisionAssignment.create({
      data: { academicYearId, divisionId, subjectId: null, teacherId: teacher.id, institutionId },
    });
    teacherToken = jwt.sign({ userId: teacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const unassignedTeacherUser = await prisma.user.create({
      data: { name: "Unassigned Teacher", email: `teacher-rmlist-2-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    await prisma.teacher.create({
      data: { teacherId: `TCH-RMLIST-2-${suffix}`, userId: unassignedTeacherUser.id, institutionId },
    });
    unassignedTeacherToken = jwt.sign({ userId: unassignedTeacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-rmlist-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STU-RMLIST-${suffix}`, userId: studentUser.id, institutionId, standardId: standard.id, divisionId, rollNo: "1" },
    });
    studentId = student.id;

    await prisma.studentRemark.create({
      data: {
        institutionId, studentId, reportedByUserId: teacherUser.id, reportedByRole: "Faculty",
        type: "YELLOW", category: "Late Submission", title: "Late assignment", detail: "Two days late.",
      },
    });
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
    await prisma.academicYear.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("teacher (assigned) can list a student's remarks", async () => {
    const res = await request(app)
      .get(`/api/teacher/classes/${divisionId}/students/${studentId}/remarks`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ title: "Late assignment", type: "yellow" });
  });

  it("teacher (unassigned) is rejected", async () => {
    const res = await request(app)
      .get(`/api/teacher/classes/${divisionId}/students/${studentId}/remarks`)
      .set("Authorization", `Bearer ${unassignedTeacherToken}`);
    expect(res.status).toBe(403);
  });

  it("admin can list a student's remarks", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/students/${studentId}/remarks`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("404s for a student not in the given division (admin)", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${otherDivisionId}/students/${studentId}/remarks`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
