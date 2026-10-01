// src/utils/academicYearAccess.test.ts
import { prisma } from "./prisma";
import { runWithAcademicClient } from "./academicContext";
import { assertAcademicYearAccess } from "./academicYearAccess";

describe("assertAcademicYearAccess", () => {
  let institutionA: string;
  let institutionB: string;
  let yearA: string;
  let yearB: string;
  let divisionA: string;
  let teacherUserId: string;
  let teacherId: string;
  let studentUserId: string;
  let studentId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;
    const instA = await prisma.institution.create({
      data: { institutionCode: `TEST-AYA-A-${suffix}`, name: `Inst A ${suffix}`, email: `a-${suffix}@example.com`, type: "SCHOOL", status: "ACTIVE" },
    });
    const instB = await prisma.institution.create({
      data: { institutionCode: `TEST-AYA-B-${suffix}`, name: `Inst B ${suffix}`, email: `b-${suffix}@example.com`, type: "SCHOOL", status: "ACTIVE" },
    });
    institutionA = instA.id;
    institutionB = instB.id;

    const standard = await prisma.standard.create({ data: { institutionId: institutionA, name: `Class 5 ${suffix}`, order: 5 } });
    const division = await prisma.division.create({ data: { standardId: standard.id, institutionId: institutionA, name: "A" } });
    divisionA = division.id;

    const ay = await prisma.academicYear.create({
      data: { institutionId: institutionA, label: `2025-26-${suffix}`, startDate: new Date(2025, 5, 1), endDate: new Date(2026, 4, 31), isCurrent: true },
    });
    yearA = ay.id;
    const ayB = await prisma.academicYear.create({
      data: { institutionId: institutionB, label: `2025-26-${suffix}`, startDate: new Date(2025, 5, 1), endDate: new Date(2026, 4, 31), isCurrent: true },
    });
    yearB = ayB.id;

    const tUser = await prisma.user.create({ data: { name: "T", email: `t-${suffix}@example.com`, role: "TEACHER", institutionId: institutionA, isActive: true } });
    teacherUserId = tUser.id;
    const teacher = await prisma.teacher.create({ data: { teacherId: `TCH-${suffix}`, userId: tUser.id, institutionId: institutionA } });
    teacherId = teacher.id;
    await prisma.divisionAssignment.create({ data: { divisionId: divisionA, subjectId: null, teacherId, institutionId: institutionA, academicYearId: yearA } });

    const sUser = await prisma.user.create({ data: { name: "S", email: `s-${suffix}@example.com`, role: "STUDENT", institutionId: institutionA, isActive: true } });
    studentUserId = sUser.id;
    const student = await prisma.student.create({ data: { studentId: `STU-${suffix}`, userId: sUser.id, institutionId: institutionA, standardId: standard.id, divisionId: divisionA } });
    studentId = student.id;
    await prisma.studentEnrollment.create({ data: { institutionId: institutionA, studentId, academicYearId: yearA, standardId: standard.id, divisionId: divisionA, status: "ACTIVE" } });
  });

  afterAll(async () => {
    // Reverse dependency order; AcademicYear before Institution.
    for (const iId of [institutionA, institutionB].filter(Boolean)) {
      await prisma.studentEnrollment.deleteMany({ where: { institutionId: iId } });
      await prisma.divisionAssignment.deleteMany({ where: { institutionId: iId } });
      await prisma.student.deleteMany({ where: { institutionId: iId } });
      await prisma.teacher.deleteMany({ where: { institutionId: iId } });
      await prisma.division.deleteMany({ where: { institutionId: iId } });
      await prisma.standard.deleteMany({ where: { institutionId: iId } });
      await prisma.user.deleteMany({ where: { institutionId: iId } });
      await prisma.academicYear.deleteMany({ where: { institutionId: iId } });
      await prisma.institution.delete({ where: { id: iId } });
    }
    await prisma.$disconnect();
  });

  it("rejects a year that belongs to a different institution", async () => {
    await runWithAcademicClient(prisma, async () => {
      await expect(
        assertAcademicYearAccess({ role: "ADMIN", userId: "irrelevant", institutionId: institutionB, academicYearId: yearA })
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  it("allows an admin full access to any year of their own institution", async () => {
    await runWithAcademicClient(prisma, async () => {
      await expect(
        assertAcademicYearAccess({ role: "ADMIN", userId: "irrelevant", institutionId: institutionA, academicYearId: yearA })
      ).resolves.toBeUndefined();
    });
  });

  it("allows a teacher access to a division they were assigned to in that year", async () => {
    await runWithAcademicClient(prisma, async () => {
      await expect(
        assertAcademicYearAccess({ role: "TEACHER", userId: teacherUserId, institutionId: institutionA, academicYearId: yearA, divisionId: divisionA })
      ).resolves.toBeUndefined();
    });
  });

  it("rejects a teacher for a division they were not assigned to in that year", async () => {
    await runWithAcademicClient(prisma, async () => {
      const otherDivision = await prisma.division.create({ data: { standardId: (await prisma.standard.findFirstOrThrow({ where: { institutionId: institutionA } })).id, institutionId: institutionA, name: "Z" } });
      await expect(
        assertAcademicYearAccess({ role: "TEACHER", userId: teacherUserId, institutionId: institutionA, academicYearId: yearA, divisionId: otherDivision.id })
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  it("allows a student access only to their own enrollment", async () => {
    await runWithAcademicClient(prisma, async () => {
      await expect(
        assertAcademicYearAccess({ role: "STUDENT", userId: studentUserId, institutionId: institutionA, academicYearId: yearA, studentId })
      ).resolves.toBeUndefined();
    });
  });

  it("rejects a student requesting a different student's data", async () => {
    await runWithAcademicClient(prisma, async () => {
      await expect(
        assertAcademicYearAccess({ role: "STUDENT", userId: studentUserId, institutionId: institutionA, academicYearId: yearA, studentId: "someone-else" })
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  it("rejects a TEACHER-role caller with no Teacher profile, even with no divisionId", async () => {
    await runWithAcademicClient(prisma, async () => {
      const noProfileUser = await prisma.user.create({
        data: { name: "No Profile", email: `no-teacher-profile-${Date.now()}@example.com`, role: "TEACHER", institutionId: institutionA, isActive: true },
      });
      await expect(
        assertAcademicYearAccess({ role: "TEACHER", userId: noProfileUser.id, institutionId: institutionA, academicYearId: yearA })
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  it("allows a SUB_ADMIN full access to any year of their own institution", async () => {
    await runWithAcademicClient(prisma, async () => {
      await expect(
        assertAcademicYearAccess({ role: "SUB_ADMIN", userId: "irrelevant", institutionId: institutionA, academicYearId: yearA })
      ).resolves.toBeUndefined();
    });
  });

  it("still rejects a SUB_ADMIN for a year belonging to a different institution", async () => {
    await runWithAcademicClient(prisma, async () => {
      await expect(
        assertAcademicYearAccess({ role: "SUB_ADMIN", userId: "irrelevant", institutionId: institutionB, academicYearId: yearA })
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  it("denies access for an unrecognized role (deny-by-default)", async () => {
    await runWithAcademicClient(prisma, async () => {
      await expect(
        assertAcademicYearAccess({ role: "HELPER", userId: "irrelevant", institutionId: institutionA, academicYearId: yearA })
      ).rejects.toMatchObject({ status: 403 });
    });
  });
});
