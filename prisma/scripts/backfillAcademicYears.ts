/**
 * One-time data migration: reconstruct AcademicYear history for institutions
 * that used the promotion feature before AcademicYear existed as a concept.
 *
 * For each institution:
 *  1. Every PromotionBatch/Marksheet row with academicYearId = null has a legacy
 *     `academicYear` string (e.g. "2024-25"). One AcademicYear row is created per
 *     distinct string (skipped if a row with that institutionId+label already
 *     exists), and every matching legacy row is pointed at it.
 *  2. StudentEnrollment history is rebuilt from PromotionBatch + StudentPromotionOutcome,
 *     now that every batch has an academicYearId.
 *  3. Attendance.academicYearId is backfilled by matching each row's date into an
 *     AcademicYear's [startDate, endDate] window.
 *
 * Safe to re-run: every step only touches rows that aren't already migrated
 * (academicYearId = null, or a not-yet-existing StudentEnrollment), so running
 * this twice is a no-op the second time.
 *
 * Usage:
 *   npx tsx prisma/scripts/backfillAcademicYears.ts
 */

import { prisma } from "../../src/utils/prisma";
import { runWithAcademicClient } from "../../src/utils/academicContext";

export interface BackfillResult {
  yearsCreated: number;
  enrollmentsCreated: number;
  attendanceRowsUpdated: number;
  marksheetRowsUpdated: number;
}

/**
 * Parses a "YYYY-YY" legacy academic year label (e.g. "2024-25") into a
 * June 1 - May 31 date window.
 *
 * Legacy labels predate any format enforcement. A leading "YYYY-YY" is
 * extracted even if the label carries a trailing suffix (e.g. historical free
 * text appended after the year), since the year window can still be derived
 * from that prefix. Only when the label doesn't even start with that shape do
 * we fall back to a window that can't match any real attendance date
 * (start === end === now) so the AcademicYear row still gets created —
 * nothing is silently dropped — but it won't false-positive-match attendance
 * rows during the date-window backfill.
 */
export function parseLegacyYearLabel(label: string): { startDate: Date; endDate: Date } {
  // Anchored only at the start: legacy labels can carry a trailing suffix
  // (e.g. test fixtures, or historical free text appended after the year),
  // and the leading YYYY-YY should still be extracted in that case.
  const match = /^(\d{4})-(\d{2})/.exec(label);
  if (!match) {
    const now = new Date();
    return { startDate: now, endDate: now };
  }
  const startYear = Number(match[1]);
  return { startDate: new Date(startYear, 5, 1), endDate: new Date(startYear + 1, 4, 31) };
}

async function resolveOrCreateYear(
  institutionId: string,
  label: string,
  yearCache: Map<string, string>
): Promise<{ id: string; created: boolean }> {
  const cacheKey = `${institutionId}:${label}`;
  const cached = yearCache.get(cacheKey);
  if (cached) return { id: cached, created: false };

  const existing = await prisma.academicYear.findUnique({ where: { institutionId_label: { institutionId, label } } });
  if (existing) {
    yearCache.set(cacheKey, existing.id);
    return { id: existing.id, created: false };
  }

  const { startDate, endDate } = parseLegacyYearLabel(label);
  const created = await prisma.academicYear.create({
    data: { institutionId, label, startDate, endDate, status: "CLOSED", isCurrent: false },
  });
  yearCache.set(cacheKey, created.id);
  return { id: created.id, created: true };
}

export async function backfillInstitution(institutionId: string): Promise<BackfillResult> {
  let yearsCreated = 0;
  const yearCache = new Map<string, string>();

  // 1. Reconstruct AcademicYear rows from legacy PromotionBatch/Marksheet strings
  //    and point each legacy row at its resolved year.
  const legacyBatches = await prisma.promotionBatch.findMany({
    where: { institutionId, academicYearId: null },
    select: { id: true, academicYear: true },
  });
  for (const batch of legacyBatches) {
    const { id, created } = await resolveOrCreateYear(institutionId, batch.academicYear, yearCache);
    if (created) yearsCreated++;
    await prisma.promotionBatch.update({ where: { id: batch.id }, data: { academicYearId: id } });
  }

  const legacyMarksheets = await prisma.marksheet.findMany({
    where: { institutionId, academicYearId: null },
    select: { id: true, academicYear: true },
  });
  for (const marksheet of legacyMarksheets) {
    const { id, created } = await resolveOrCreateYear(institutionId, marksheet.academicYear, yearCache);
    if (created) yearsCreated++;
    await prisma.marksheet.update({ where: { id: marksheet.id }, data: { academicYearId: id } });
  }
  const marksheetRowsUpdated = legacyMarksheets.length;

  // 2. Reconstruct StudentEnrollment from PromotionBatch + StudentPromotionOutcome,
  //    now that every batch (including previously-legacy ones) has an academicYearId.
  let enrollmentsCreated = 0;
  const batches = await prisma.promotionBatch.findMany({
    where: { institutionId },
    include: { outcomes: true },
  });
  for (const batch of batches) {
    if (!batch.academicYearId) continue; // defensive: step 1 should have resolved every row
    for (const outcome of batch.outcomes) {
      const existing = await prisma.studentEnrollment.findUnique({
        where: { studentId_academicYearId: { studentId: outcome.studentId, academicYearId: batch.academicYearId } },
      });
      if (existing) continue;

      await prisma.studentEnrollment.create({
        data: {
          institutionId,
          studentId: outcome.studentId,
          academicYearId: batch.academicYearId,
          standardId: outcome.previousStandardId,
          divisionId: outcome.previousDivisionId,
          status: outcome.previousStatus,
        },
      });
      enrollmentsCreated++;
    }
  }

  // 3. Backfill Attendance.academicYearId by matching each row's date into a year's window.
  const years = await prisma.academicYear.findMany({ where: { institutionId } });
  let attendanceRowsUpdated = 0;
  for (const year of years) {
    const result = await prisma.attendance.updateMany({
      where: {
        institutionId,
        academicYearId: null,
        date: { gte: year.startDate.toISOString().slice(0, 10), lte: year.endDate.toISOString().slice(0, 10) },
      },
      data: { academicYearId: year.id },
    });
    attendanceRowsUpdated += result.count;
  }

  return { yearsCreated, enrollmentsCreated, attendanceRowsUpdated, marksheetRowsUpdated };
}

async function main() {
  const institutions = await prisma.institution.findMany({ select: { id: true } });
  for (const institution of institutions) {
    const result = await runWithAcademicClient(prisma, () => backfillInstitution(institution.id));
    console.log(`Backfilled institution ${institution.id}:`, result);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
