import { academicDb } from "./academicContext";
import type { AcademicClient } from "./academicContext";
import type { AcademicYear } from "../generated/prisma/client";
import { Prisma } from "../generated/prisma/client";

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

// `client` defaults to the ambient request-scoped academicDb(). Pass an explicit
// client when resolving a year for an institution other than the one bound to
// the current async scope (e.g. feeInsights' cross-institution peer loop, where
// each peer may live in its own BYOD database).
export async function getCurrentAcademicYear(
  institutionId: string,
  client: AcademicClient = academicDb()
): Promise<AcademicYear> {
  const db = client;
  const existing = await db.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
  if (existing) return existing;

  const { label, startDate, endDate } = computeDefaultAcademicYearWindow();
  try {
    return await db.academicYear.create({
      data: { institutionId, label, startDate, endDate, isCurrent: true, status: "ACTIVE" },
    });
  } catch (err) {
    // Only handle unique constraint race; rethrow other errors
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const retry = await db.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
      if (retry) return retry;
      throw new Error(`Failed to resolve current academic year for institution ${institutionId}`, { cause: err });
    }
    // Not a unique constraint error; rethrow as-is to avoid masking real infrastructure failures
    throw err;
  }
}
