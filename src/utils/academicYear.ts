import { academicDb } from "./academicContext";
import type { AcademicClient } from "./academicContext";
import type { AcademicYear, StudentEnrollment, StudentStatus } from "../generated/prisma/client";
import { Prisma } from "../generated/prisma/client";
import { assertAcademicYearAccess } from "./academicYearAccess";

// Accepts both a full AcademicClient and a Prisma interactive-transaction
// client (`tx`), which lacks $connect/$disconnect/etc. but shares the same
// model delegates these functions actually use.
type AcademicYearClient = Pick<AcademicClient, "academicYear">;
type EnrollmentClient = Pick<AcademicClient, "academicYear" | "studentEnrollment">;

export function computeDefaultAcademicYearWindow(
  referenceDate: Date = new Date()
): { label: string; startDate: Date; endDate: Date } {
  const month = referenceDate.getMonth(); // 0-indexed
  const year = referenceDate.getFullYear();
  const startYear = month >= 5 ? year : year - 1; // June cutoff
  return {
    label: `${startYear}-${String(startYear + 1).slice(2)}`,
    startDate: new Date(startYear, 5, 1),
    endDate: new Date(startYear + 1, 4, 31),
  };
}

async function findOrCreateAcademicYearForWindow(
  institutionId: string,
  client: AcademicYearClient,
  window: { label: string; startDate: Date; endDate: Date },
  isCurrent: boolean
): Promise<AcademicYear> {
  const existing = await client.academicYear.findFirst({ where: { institutionId, label: window.label } });
  if (existing) return existing;

  try {
    return await client.academicYear.create({
      data: { institutionId, ...window, isCurrent, status: "ACTIVE" },
    });
  } catch (err) {
    // Only handle unique constraint race; rethrow other errors
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const retry = await client.academicYear.findFirst({ where: { institutionId, label: window.label } });
      if (retry) return retry;
      throw new Error(`Failed to resolve academic year "${window.label}" for institution ${institutionId}`, { cause: err });
    }
    // Not a unique constraint error; rethrow as-is to avoid masking real infrastructure failures
    throw err;
  }
}

// `client` defaults to the ambient request-scoped academicDb(). Pass an explicit
// client when resolving a year for an institution other than the one bound to
// the current async scope (e.g. feeInsights' cross-institution peer loop, where
// each peer may live in its own BYOD database).
export async function getCurrentAcademicYear(
  institutionId: string,
  client: AcademicYearClient = academicDb()
): Promise<AcademicYear> {
  const existing = await client.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
  if (existing) return existing;

  return findOrCreateAcademicYearForWindow(institutionId, client, computeDefaultAcademicYearWindow(), true);
}

// Resolves (lazily creating if needed) the AcademicYear immediately following
// `afterYear`, without regard to which year is currently marked `isCurrent`.
// Used by promotion so a student's post-transition enrollment always targets
// "the year after the one being closed out" — whether or not an admin has
// already run the separate "start new year" rollover action. The lazily
// created row is deliberately NOT marked current; only the explicit rollover
// action changes `isCurrent`.
export async function getNextAcademicYear(
  institutionId: string,
  afterYear: AcademicYear,
  client: AcademicYearClient = academicDb()
): Promise<AcademicYear> {
  const dayAfterEnd = new Date(afterYear.endDate.getTime() + 24 * 60 * 60 * 1000);
  const window = computeDefaultAcademicYearWindow(dayAfterEnd);
  return findOrCreateAcademicYearForWindow(institutionId, client, window, false);
}

// Creates or updates a student's StudentEnrollment row for the institution's
// current academic year — the single write path for "this student now
// belongs to this standard/division/status, as of the current year", used by
// both new-student creation and any later move between divisions/standards.
export async function upsertCurrentEnrollment(
  institutionId: string,
  params: { studentId: string; standardId: string; divisionId: string; status: StudentStatus },
  client: EnrollmentClient = academicDb()
): Promise<StudentEnrollment> {
  const currentYear = await getCurrentAcademicYear(institutionId, client);
  return client.studentEnrollment.upsert({
    where: { studentId_academicYearId: { studentId: params.studentId, academicYearId: currentYear.id } },
    create: {
      institutionId,
      studentId: params.studentId,
      academicYearId: currentYear.id,
      standardId: params.standardId,
      divisionId: params.divisionId,
      status: params.status,
    },
    update: {
      standardId: params.standardId,
      divisionId: params.divisionId,
      status: params.status,
    },
  });
}

// Resolves the requested academic year for the given institution and auth context.
// Returns the current year if academicYearIdParam is omitted.
// If a specific year is requested, validates it belongs to the same institution,
// checks authorization, and returns it.
// Throws { status: 404, message: string } if the year is not found or belongs to a different institution.
// Throws { status: 403, message: string } if access is denied.
export async function resolveRequestedAcademicYear(
  academicYearIdParam: string | undefined,
  institutionId: string,
  auth: { role: string; userId: string }
): Promise<AcademicYear> {
  if (!academicYearIdParam) return getCurrentAcademicYear(institutionId);
  const db = academicDb();
  const year = await db.academicYear.findFirst({ where: { id: academicYearIdParam, institutionId } });
  if (!year) throw { status: 404, message: "Academic year not found" };
  await assertAcademicYearAccess({ role: auth.role, userId: auth.userId, institutionId, academicYearId: year.id });
  return year;
}
