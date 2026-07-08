import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("GET /api/student/remarks", () => {
  let institutionId: string;
  let otherInstitutionId: string;
  let studentId: string;
  let studentToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-SRM-${suffix}`,
        name: `Test Institution SRM ${suffix}`,
        email: `test-srm-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const otherInstitution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-SRM2-${suffix}`,
        name: `Other Institution SRM ${suffix}`,
        email: `test-srm2-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    otherInstitutionId = otherInstitution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class SRM ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-srm-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STU-SRM-${suffix}`, userId: studentUser.id, institutionId, standardId: standard.id, divisionId: division.id, rollNo: "1" },
    });
    studentId = student.id;
    studentToken = jwt.sign({ userId: studentUser.id, role: "STUDENT", institutionId }, process.env.JWT_SECRET!);

    const teacherUser = await prisma.user.create({
      data: { name: "Reporting Teacher", email: `teacher-srm-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });

    await prisma.studentRemark.create({
      data: {
        institutionId, studentId, reportedByUserId: teacherUser.id, reportedByRole: "Faculty",
        type: "YELLOW", category: "Late Submission", title: "Late assignment", detail: "Two days late.",
      },
    });
    await prisma.studentRemark.create({
      data: {
        institutionId, studentId, reportedByUserId: teacherUser.id, reportedByRole: "Faculty",
        type: "RED", category: "Academic Dishonesty", title: "Copying", detail: "Caught with notes.",
      },
    });

    // A remark belonging to a different institution's student must never leak
    const otherStandard = await prisma.standard.create({
      data: { institutionId: otherInstitutionId, name: `Other SRM ${suffix}`, order: 1 },
    });
    const otherDivision = await prisma.division.create({
      data: { standardId: otherStandard.id, institutionId: otherInstitutionId, name: "A" },
    });
    const otherStudentUser = await prisma.user.create({
      data: { name: "Other Student", email: `other-student-srm-${suffix}@example.com`, role: "STUDENT", institutionId: otherInstitutionId, isActive: true },
    });
    const otherStudent = await prisma.student.create({
      data: { studentId: `STU-SRM2-${suffix}`, userId: otherStudentUser.id, institutionId: otherInstitutionId, standardId: otherStandard.id, divisionId: otherDivision.id, rollNo: "1" },
    });
    const otherTeacherUser = await prisma.user.create({
      data: { name: "Other Teacher", email: `other-teacher-srm-${suffix}@example.com`, role: "TEACHER", institutionId: otherInstitutionId, isActive: true },
    });
    await prisma.studentRemark.create({
      data: {
        institutionId: otherInstitutionId, studentId: otherStudent.id, reportedByUserId: otherTeacherUser.id, reportedByRole: "Faculty",
        type: "RED", category: "Unrelated", title: "Should never appear", detail: "Cross-tenant leak check.",
      },
    });
  });

  afterAll(async () => {
    if (!institutionId || !otherInstitutionId) { await prisma.$disconnect(); return; }
    await prisma.studentRemark.deleteMany({ where: { institutionId: { in: [institutionId, otherInstitutionId] } } });
    await prisma.student.deleteMany({ where: { institutionId: { in: [institutionId, otherInstitutionId] } } });
    await prisma.division.deleteMany({ where: { institutionId: { in: [institutionId, otherInstitutionId] } } });
    await prisma.standard.deleteMany({ where: { institutionId: { in: [institutionId, otherInstitutionId] } } });
    await prisma.user.deleteMany({ where: { institutionId: { in: [institutionId, otherInstitutionId] } } });
    await prisma.institution.deleteMany({ where: { id: { in: [institutionId, otherInstitutionId] } } });
    await prisma.$disconnect();
  });

  it("returns only this student's own remarks, newest first, in FlagItem shape", async () => {
    const res = await request(app)
      .get("/api/student/remarks")
      .set("Authorization", `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ title: "Copying", type: "red", role: "Faculty", status: "active" });
    expect(res.body.data[1]).toMatchObject({ title: "Late assignment", type: "yellow" });
    expect(res.body.data.some((r: { title: string }) => r.title === "Should never appear")).toBe(false);
  });
});
