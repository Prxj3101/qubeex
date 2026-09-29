import { academicDb } from "../../utils/academicContext";
import { getCurrentAcademicYear } from "../../utils/academicYear";
import { Prisma } from "../../generated/prisma/client";
import { StartNewAcademicYearInput } from "./academicYear.schema";

export interface AcademicYearSummary {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  status: "ACTIVE" | "CLOSED";
  isCurrent: boolean;
}

function toSummary(y: {
  id: string; label: string; startDate: Date; endDate: Date; status: string; isCurrent: boolean;
}): AcademicYearSummary {
  return {
    id: y.id,
    label: y.label,
    startDate: y.startDate.toISOString(),
    endDate: y.endDate.toISOString(),
    status: y.status as "ACTIVE" | "CLOSED",
    isCurrent: y.isCurrent,
  };
}

export async function listAcademicYears(institutionId: string): Promise<AcademicYearSummary[]> {
  await getCurrentAcademicYear(institutionId); // ensures at least one exists
  const years = await academicDb().academicYear.findMany({
    where: { institutionId },
    orderBy: { startDate: "desc" },
  });
  return years.map(toSummary);
}

export async function startNewAcademicYear(
  institutionId: string,
  input: StartNewAcademicYearInput
): Promise<AcademicYearSummary> {
  const db = academicDb();
  const created = await db.$transaction(async (tx) => {
    // Under READ COMMITTED, `UPDATE ... WHERE isCurrent = true` only locks/rechecks
    // the rows it found in its initial scan — it will not notice a row that became
    // isCurrent = true *after* that scan (e.g. from a concurrent transaction that
    // committed in between). That means two concurrent calls for the same
    // institution could each close what they saw as "current" and then both flip
    // their own new row to current, leaving two isCurrent rows. Prisma has no
    // native explicit row-locking primitive, so we serialize concurrent calls for
    // this institution with a transaction-scoped Postgres advisory lock keyed on
    // institutionId (pg_advisory_xact_lock auto-releases on commit/rollback, same
    // lifecycle as a row lock). We use an advisory lock rather than locking a real
    // row (e.g. Institution) because academicDb() can resolve to either the
    // central DB or a BYOD tenant's own DB depending on the institution, and
    // Institution is a platform-only model that doesn't exist in tenant schemas
    // (see PLATFORM_MODELS in modelClassification.ts / build-tenant-schema.cjs) —
    // an advisory lock needs no table to exist at all, so it works identically
    // against both database shapes.
    // $executeRaw (not $queryRaw) — pg_advisory_xact_lock returns void, which
    // this Prisma driver adapter can't decode as a query result column type
    // ("UnsupportedNativeDataType"); $executeRaw only reports affected-row
    // count and doesn't attempt to decode a result set.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${institutionId})::bigint)`;

    // @@unique([institutionId, label]) — surface a reused label as a 409 rather
    // than an unhandled 500. Throwing out of the callback rolls the tx back.
    const year = await tx.academicYear
      .create({
        data: {
          institutionId,
          label: input.label,
          startDate: new Date(input.startDate),
          endDate: new Date(input.endDate),
          status: "ACTIVE",
          isCurrent: false,
        },
      })
      .catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw { status: 409, message: "An academic year with this label already exists" };
        }
        throw err;
      });

    await tx.academicYear.updateMany({
      where: { institutionId, isCurrent: true, id: { not: year.id } },
      data: { isCurrent: false, status: "CLOSED" },
    });
    await tx.academicYear.update({
      where: { id: year.id },
      data: { isCurrent: true },
    });

    return tx.academicYear.findUniqueOrThrow({ where: { id: year.id } });
  });

  return toSummary(created);
}
