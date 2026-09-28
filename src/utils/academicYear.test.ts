import { prisma } from "./prisma";
import { runWithAcademicClient } from "./academicContext";
import { getCurrentAcademicYear, computeDefaultAcademicYearWindow } from "./academicYear";

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
