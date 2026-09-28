import { prisma } from "../../src/utils/prisma";
import { runWithAcademicClient } from "../../src/utils/academicContext";
import { backfillInstitution, parseLegacyYearLabel } from "./backfillAcademicYears";

describe("parseLegacyYearLabel", () => {
  it("parses a YYYY-YY label into a June 1 - May 31 window", () => {
    const result = parseLegacyYearLabel("2024-25");
    expect(result.startDate).toEqual(new Date(2024, 5, 1));
    expect(result.endDate).toEqual(new Date(2025, 4, 31));
  });
});

describe("backfillInstitution", () => {
  let institutionId: string;
  let standardId: string;
  let division5AId: string;
  let division6AId: string;
  let studentId: string;
  let legacyLabel: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;
    const institution = await prisma.institution.create({
      data: { institutionCode: `TEST-BF-${suffix}`, name: `Backfill Inst ${suffix}`, email: `bf-${suffix}@example.com`, type: "SCHOOL", status: "ACTIVE" },
    });
    institutionId = institution.id;
    legacyLabel = `2024-25-${suffix}`; // suffixed so parseLegacyYearLabel's real parsing isn't exercised here — that's covered above

    const standard5 = await prisma.standard.create({ data: { institutionId, name: `Class 5 ${suffix}`, order: 5 } });
    const standard6 = await prisma.standard.create({ data: { institutionId, name: `Class 6 ${suffix}`, order: 6 } });
    standardId = standard5.id;
    const division5A = await prisma.division.create({ data: { standardId: standard5.id, institutionId, name: "A" } });
    const division6A = await prisma.division.create({ data: { standardId: standard6.id, institutionId, name: "A" } });
    division5AId = division5A.id;
    division6AId = division6A.id;

    const user = await prisma.user.create({ data: { name: "Student", email: `bf-stu-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true } });
    const student = await prisma.student.create({ data: { studentId: `STU-BF-${suffix}`, userId: user.id, institutionId, standardId: standard6.id, divisionId: division6AId } });
    studentId = student.id;

    // Simulate a historical promotion batch from before this feature existed:
    // legacy string set, academicYearId left null, exactly as real pre-migration rows are.
    const batch = await prisma.promotionBatch.create({
      data: {
        institutionId,
        fromStandardId: standardId,
        fromDivisionId: division5AId,
        toDivisionId: division6AId,
        academicYear: legacyLabel,
        triggeredById: user.id,
        triggeredByRole: "TEACHER",
      },
    });
    await prisma.studentPromotionOutcome.create({
      data: { batchId: batch.id, studentId, institutionId, outcome: "PROMOTED", previousStandardId: standardId, previousDivisionId: division5AId, previousStatus: "ACTIVE" },
    });

    // A pre-existing attendance row with no academicYearId set, dated inside the legacy year's window.
    await prisma.attendance.create({
      data: { institutionId, divisionId: division5AId, studentId, date: "2024-11-05", status: "PRESENT" },
    });
  });

  it("creates one AcademicYear per distinct legacy label and points the legacy row at it", async () => {
    await runWithAcademicClient(prisma, async () => {
      await backfillInstitution(institutionId);
      const year = await prisma.academicYear.findFirst({ where: { institutionId, label: legacyLabel } });
      expect(year).not.toBeNull();
      const batch = await prisma.promotionBatch.findFirst({ where: { institutionId, academicYear: legacyLabel } });
      expect(batch!.academicYearId).toBe(year!.id);
    });
  });

  it("creates a StudentEnrollment for the reconstructed historical year", async () => {
    await runWithAcademicClient(prisma, async () => {
      const year = await prisma.academicYear.findFirst({ where: { institutionId, label: legacyLabel } });
      const enrollment = await prisma.studentEnrollment.findFirst({ where: { studentId, academicYearId: year!.id } });
      expect(enrollment).not.toBeNull();
      expect(enrollment!.divisionId).toBe(division5AId);
    });
  });

  it("backfills the pre-existing attendance row's academicYearId by date match", async () => {
    await runWithAcademicClient(prisma, async () => {
      const year = await prisma.academicYear.findFirst({ where: { institutionId, label: legacyLabel } });
      const attendance = await prisma.attendance.findFirst({ where: { institutionId, studentId, date: "2024-11-05" } });
      expect(attendance!.academicYearId).toBe(year!.id);
    });
  });

  it("is idempotent — running twice creates no duplicate years or enrollments", async () => {
    await runWithAcademicClient(prisma, async () => {
      const before = await prisma.academicYear.count({ where: { institutionId } });
      const beforeEnrollments = await prisma.studentEnrollment.count({ where: { institutionId } });
      await backfillInstitution(institutionId);
      const after = await prisma.academicYear.count({ where: { institutionId } });
      const afterEnrollments = await prisma.studentEnrollment.count({ where: { institutionId } });
      expect(after).toBe(before);
      expect(afterEnrollments).toBe(beforeEnrollments);
    });
  });
});
