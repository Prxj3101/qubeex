import { prisma } from "./prisma";
import { runWithAcademicClient } from "./academicContext";
import { getCurrentAcademicYear, getNextAcademicYear, upsertCurrentEnrollment, computeDefaultAcademicYearWindow } from "./academicYear";

describe("computeDefaultAcademicYearWindow", () => {
  it("returns the June-July year for a date in August", () => {
    const result = computeDefaultAcademicYearWindow(new Date(2026, 7, 15));
    expect(result.label).toBe("2026-27");
    expect(result.startDate).toEqual(new Date(2026, 5, 1));
    expect(result.endDate).toEqual(new Date(2027, 4, 31));
  });

  it("returns the prior year for a date in March", () => {
    const result = computeDefaultAcademicYearWindow(new Date(2026, 2, 1));
    expect(result.label).toBe("2025-26");
  });
});

describe("getCurrentAcademicYear", () => {
  let institutionId: string;
  const createdInstitutionIds: string[] = [];

  beforeAll(async () => {
    const suffix = `${Date.now()}`;
    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-AY-${suffix}`,
        name: `Test Institution AY ${suffix}`,
        email: `test-ay-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    createdInstitutionIds.push(institutionId);
  });

  afterAll(async () => {
    // Clean up all test data in reverse dependency order
    for (const iId of createdInstitutionIds) {
      await prisma.academicYear.deleteMany({ where: { institutionId: iId } });
      await prisma.institution.delete({ where: { id: iId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("lazily creates a current year when none exists", async () => {
    await runWithAcademicClient(prisma, async () => {
      const year = await getCurrentAcademicYear(institutionId);
      expect(year.institutionId).toBe(institutionId);
      expect(year.isCurrent).toBe(true);
    });
  });

  it("returns the same row on a second call, not a duplicate", async () => {
    await runWithAcademicClient(prisma, async () => {
      const first = await getCurrentAcademicYear(institutionId);
      const second = await getCurrentAcademicYear(institutionId);
      expect(second.id).toBe(first.id);
      const count = await prisma.academicYear.count({ where: { institutionId } });
      expect(count).toBe(1);
    });
  });

  it("handles concurrent calls with Promise.all without creating duplicates", async () => {
    await runWithAcademicClient(prisma, async () => {
      // Create a fresh institution with no AcademicYear yet
      const suffix = `${Date.now()}-concurrent`;
      const concurrentInst = await prisma.institution.create({
        data: {
          institutionCode: `TEST-AY-RACE-${suffix}`,
          name: `Test Institution Race ${suffix}`,
          email: `test-ay-race-${suffix}@example.com`,
          type: "SCHOOL",
          status: "ACTIVE",
        },
      });
      const concurrentInstId = concurrentInst.id;
      createdInstitutionIds.push(concurrentInstId);

      // Race both calls: both should try to create, one wins, other retries and finds
      const [first, second] = await Promise.all([
        getCurrentAcademicYear(concurrentInstId),
        getCurrentAcademicYear(concurrentInstId),
      ]);

      // Both should resolve to the same row
      expect(first.id).toBe(second.id);
      expect(first.institutionId).toBe(concurrentInstId);
      expect(second.institutionId).toBe(concurrentInstId);
      expect(first.isCurrent).toBe(true);
      expect(second.isCurrent).toBe(true);

      // Exactly one row should exist (race-condition safety verified)
      const count = await prisma.academicYear.count({ where: { institutionId: concurrentInstId } });
      expect(count).toBe(1);
    });
  });
});

describe("getNextAcademicYear", () => {
  let institutionId: string;
  const createdInstitutionIds: string[] = [];

  beforeAll(async () => {
    const suffix = `${Date.now()}-next`;
    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-AY-NEXT-${suffix}`,
        name: `Test Institution AY Next ${suffix}`,
        email: `test-ay-next-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    createdInstitutionIds.push(institutionId);
  });

  afterAll(async () => {
    for (const iId of createdInstitutionIds) {
      await prisma.academicYear.deleteMany({ where: { institutionId: iId } });
      await prisma.institution.delete({ where: { id: iId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("lazily creates the year immediately following a given year, not marked current", async () => {
    await runWithAcademicClient(prisma, async () => {
      const year2024 = await prisma.academicYear.create({
        data: {
          institutionId,
          label: "2024-25",
          startDate: new Date(2024, 5, 1),
          endDate: new Date(2025, 4, 31),
          isCurrent: false,
          status: "CLOSED",
        },
      });

      const next = await getNextAcademicYear(institutionId, year2024);
      expect(next.label).toBe("2025-26");
      expect(next.startDate).toEqual(new Date(2025, 5, 1));
      expect(next.endDate).toEqual(new Date(2026, 4, 31));
      expect(next.isCurrent).toBe(false);
    });
  });

  it("returns the existing row if the next year already exists", async () => {
    await runWithAcademicClient(prisma, async () => {
      const suffix = `${Date.now()}-existing`;
      const inst = await prisma.institution.create({
        data: {
          institutionCode: `TEST-AY-NEXT-EXIST-${suffix}`,
          name: `Test Institution AY Next Exist ${suffix}`,
          email: `test-ay-next-exist-${suffix}@example.com`,
          type: "SCHOOL",
          status: "ACTIVE",
        },
      });
      createdInstitutionIds.push(inst.id);

      const yearA = await prisma.academicYear.create({
        data: { institutionId: inst.id, label: "2030-31", startDate: new Date(2030, 5, 1), endDate: new Date(2031, 4, 31), isCurrent: true, status: "ACTIVE" },
      });
      const yearB = await prisma.academicYear.create({
        data: { institutionId: inst.id, label: "2031-32", startDate: new Date(2031, 5, 1), endDate: new Date(2032, 4, 31), isCurrent: false, status: "ACTIVE" },
      });

      const next = await getNextAcademicYear(inst.id, yearA);
      expect(next.id).toBe(yearB.id);

      const count = await prisma.academicYear.count({ where: { institutionId: inst.id } });
      expect(count).toBe(2);
    });
  });
});

describe("upsertCurrentEnrollment", () => {
  let institutionId: string;
  let standardId: string;
  let divisionAId: string;
  let divisionBId: string;
  let studentId: string;
  const createdInstitutionIds: string[] = [];

  beforeAll(async () => {
    const suffix = `${Date.now()}-enroll`;
    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-AY-ENROLL-${suffix}`,
        name: `Test Institution Enroll ${suffix}`,
        email: `test-ay-enroll-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    createdInstitutionIds.push(institutionId);

    const standard = await prisma.standard.create({ data: { institutionId, name: `Class Enroll ${suffix}`, order: 1 } });
    standardId = standard.id;
    const divisionA = await prisma.division.create({ data: { standardId, institutionId, name: "A" } });
    const divisionB = await prisma.division.create({ data: { standardId, institutionId, name: "B" } });
    divisionAId = divisionA.id;
    divisionBId = divisionB.id;

    const studentUser = await prisma.user.create({
      data: { name: "Enroll Student", email: `enroll-stu-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STU-ENROLL-${suffix}`, userId: studentUser.id, institutionId, standardId, divisionId: divisionAId },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    for (const iId of createdInstitutionIds) {
      await prisma.studentEnrollment.deleteMany({ where: { institutionId: iId } });
      await prisma.student.deleteMany({ where: { institutionId: iId } });
      await prisma.user.deleteMany({ where: { institutionId: iId } });
      await prisma.division.deleteMany({ where: { institutionId: iId } });
      await prisma.standard.deleteMany({ where: { institutionId: iId } });
      await prisma.academicYear.deleteMany({ where: { institutionId: iId } });
      await prisma.institution.delete({ where: { id: iId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("creates a current-year enrollment row when none exists (new student)", async () => {
    await runWithAcademicClient(prisma, async () => {
      const enrollment = await upsertCurrentEnrollment(institutionId, {
        studentId,
        standardId,
        divisionId: divisionAId,
        status: "ACTIVE",
      });
      expect(enrollment.divisionId).toBe(divisionAId);
      expect(enrollment.standardId).toBe(standardId);
      expect(enrollment.status).toBe("ACTIVE");

      const count = await prisma.studentEnrollment.count({ where: { studentId } });
      expect(count).toBe(1);
    });
  });

  it("updates the existing current-year row in place when the student moves divisions", async () => {
    await runWithAcademicClient(prisma, async () => {
      const moved = await upsertCurrentEnrollment(institutionId, {
        studentId,
        standardId,
        divisionId: divisionBId,
        status: "ACTIVE",
      });
      expect(moved.divisionId).toBe(divisionBId);

      // Still exactly one row for this student — updated in place, not duplicated.
      const count = await prisma.studentEnrollment.count({ where: { studentId } });
      expect(count).toBe(1);
    });
  });
});
