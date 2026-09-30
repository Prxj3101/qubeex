import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("GET /admin/campus/divisions/:divisionId/students — permission widening", () => {
  let institutionId: string;
  let divisionId: string;
  let subAdminToken: string;
  let adminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-DS-${suffix}`,
        name: `Test Institution DS ${suffix}`,
        email: `test-ds-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class DS ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    divisionId = division.id;

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-ds-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    const subAdminUser = await prisma.user.create({
      data: { name: "Test SubAdmin", email: `subadmin-ds-${suffix}@example.com`, role: "SUB_ADMIN", institutionId, isActive: true },
    });
    await prisma.subAdmin.create({
      data: { userId: subAdminUser.id, institutionId, permissions: ["CAMPUS_MANAGE"], createdById: adminUser.id },
    });

    subAdminToken = jwt.sign({ userId: subAdminUser.id, role: "SUB_ADMIN", institutionId }, process.env.JWT_SECRET!);
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.subAdmin.deleteMany({ where: { institutionId } });
    // Cleanup for the "academic year awareness" block below, which reuses this
    // same institution and adds StudentEnrollment/Student/AcademicYear rows
    // that reference this institution's divisions/standards/users — these must
    // be removed before the division/standard/user deletes below or those
    // deletes fail on the still-referencing rows.
    await prisma.studentEnrollment.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.academicYear.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("allows a sub-admin with only CAMPUS_MANAGE (no CAMPUS_ATTENDANCE) to list division students", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/students`)
      .set("Authorization", `Bearer ${subAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  describe("GET /admin/campus/divisions/:divisionId/students — academic year awareness", () => {
    let pastYearId: string;
    let pastYearDivisionId: string;
    let pastOnlyStudentId: string;

    beforeAll(async () => {
      const suffix = `${Date.now()}-yearaware`;
      const pastStandard = await prisma.standard.create({ data: { institutionId, name: `Class DS Past ${suffix}`, order: 2 } });
      const pastDivision = await prisma.division.create({ data: { standardId: pastStandard.id, institutionId, name: "P" } });
      pastYearDivisionId = pastDivision.id;

      const pastYear = await prisma.academicYear.create({
        data: { institutionId, label: `2019-20-${suffix}`, startDate: new Date(2019, 5, 1), endDate: new Date(2020, 4, 31), isCurrent: false, status: "CLOSED" },
      });
      pastYearId = pastYear.id;

      // A student who was in the past-year division but has since moved elsewhere —
      // their current Student.divisionId is NOT pastYearDivisionId, only their
      // historical StudentEnrollment row is. This is exactly what proves the
      // endpoint reads StudentEnrollment for a past year, not live Student rows.
      const user = await prisma.user.create({
        data: { name: "Past Only Student", email: `past-only-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
      });
      const student = await prisma.student.create({
        data: { studentId: `STU-PASTONLY-${suffix}`, userId: user.id, institutionId, standardId: pastStandard.id, divisionId },
      });
      pastOnlyStudentId = student.id;
      await prisma.studentEnrollment.create({
        data: { institutionId, studentId: student.id, academicYearId: pastYearId, standardId: pastStandard.id, divisionId: pastYearDivisionId, status: "ACTIVE" },
      });
    });

    it("returns the historical roster via StudentEnrollment when academicYearId is a past year", async () => {
      const res = await request(app)
        .get(`/api/admin/campus/divisions/${pastYearDivisionId}/students`)
        .query({ academicYearId: pastYearId })
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((s: { id: string }) => s.id);
      expect(ids).toContain(pastOnlyStudentId);
    });

    it("still returns live Student data when academicYearId is omitted (regression)", async () => {
      const res = await request(app)
        .get(`/api/admin/campus/divisions/${pastYearDivisionId}/students`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      // pastOnlyStudentId's live divisionId is not pastYearDivisionId, so it must NOT appear here.
      const ids = res.body.data.map((s: { id: string }) => s.id);
      expect(ids).not.toContain(pastOnlyStudentId);
    });

    it("rejects a cross-institution academicYearId with 404", async () => {
      const suffix = `${Date.now()}-other`;
      const otherInst = await prisma.institution.create({
        data: { institutionCode: `TEST-DS-OTHER-${suffix}`, name: `Other DS Inst ${suffix}`, email: `other-ds-${suffix}@example.com`, type: "SCHOOL", status: "ACTIVE" },
      });
      const otherYear = await prisma.academicYear.create({
        data: { institutionId: otherInst.id, label: `2021-22-${suffix}`, startDate: new Date(2021, 5, 1), endDate: new Date(2022, 4, 31), isCurrent: true, status: "ACTIVE" },
      });
      const res = await request(app)
        .get(`/api/admin/campus/divisions/${pastYearDivisionId}/students`)
        .query({ academicYearId: otherYear.id })
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
      await prisma.academicYear.deleteMany({ where: { institutionId: otherInst.id } });
      await prisma.institution.delete({ where: { id: otherInst.id } });
    });
  });
});
