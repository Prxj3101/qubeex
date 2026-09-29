import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { getCurrentAcademicYear, getNextAcademicYear, computeDefaultAcademicYearWindow } from "../../utils/academicYear";
import { Prisma } from "../../generated/prisma/client";
import { SubmitOutcomesInput } from "./promotion.schema";

export interface PreviewStudent { id: string; studentId: string; name: string | null; rollNo: string | null }
export interface PreviewTarget { divisionId: string; name: string; currentHeadcount: number; capacity: number | null }
export interface PreviewData {
  sourceDivision: { id: string; name: string; standardName: string };
  students: PreviewStudent[];
  isHighestStandard: boolean;
  targets: PreviewTarget[];
}

export async function getPromotionPreview(
  divisionId: string,
  institutionId: string
): Promise<PreviewData | null> {
  const division = await academicDb().division.findFirst({
    where: { id: divisionId, institutionId },
    select: { id: true, name: true, standardId: true, standard: { select: { name: true, order: true } } },
  });
  if (!division) return null;

  const [students, nextStandard] = await Promise.all([
    academicDb().student.findMany({
      where: { divisionId, institutionId, status: "ACTIVE" },
      orderBy: [{ rollNo: "asc" }, { joinedAt: "asc" }],
      select: { id: true, studentId: true, rollNo: true, userId: true },
    }),
    academicDb().standard.findFirst({
      where: { institutionId, order: division.standard.order + 1 },
      select: { id: true },
    }),
  ]);

  let targets: PreviewTarget[] = [];
  if (nextStandard) {
    const divisions = await academicDb().division.findMany({
      where: { standardId: nextStandard.id, institutionId },
      select: { id: true, name: true, capacity: true, _count: { select: { students: { where: { status: "ACTIVE" } } } } },
    });
    targets = divisions.map((d) => ({
      divisionId: d.id,
      name: d.name,
      currentHeadcount: d._count.students,
      capacity: d.capacity,
    }));
  }

  const users = await resolveUsers(students.map((s) => s.userId), { id: true, name: true });

  return {
    sourceDivision: { id: division.id, name: division.name, standardName: division.standard.name },
    students: students.map((s) => ({ id: s.id, studentId: s.studentId, name: users.get(s.userId)?.name ?? null, rollNo: s.rollNo })),
    isHighestStandard: !nextStandard,
    targets,
  };
}

export async function applyPromotionOutcomes(params: {
  divisionId: string;
  institutionId: string;
  userId: string;
  actorRole: string;
  input: SubmitOutcomesInput;
}): Promise<{ batchId: string; warning?: string }> {
  const { divisionId, institutionId, userId, actorRole, input } = params;

  const division = await academicDb().division.findFirst({
    where: { id: divisionId, institutionId },
    select: { id: true, standardId: true },
  });
  if (!division) throw { status: 404, message: "Division not found" };

  const studentIds = input.outcomes.map((o) => o.studentId);
  const students = await academicDb().student.findMany({
    where: { id: { in: studentIds }, divisionId, institutionId, status: "ACTIVE" },
    select: { id: true, standardId: true, divisionId: true, status: true },
  });
  if (students.length !== studentIds.length) {
    throw { status: 400, message: "One or more students are not active members of this division" };
  }
  for (const s of students) {
    if (!s.standardId || !s.divisionId) {
      throw { status: 400, message: "A student is missing class assignment data and cannot be processed" };
    }
  }

  const hasPromoted = input.outcomes.some((o) => o.outcome === "PROMOTED");
  let targetDivision: { id: string; standardId: string; name: string; capacity: number | null } | null = null;
  if (hasPromoted) {
    if (!input.targetDivisionId) throw { status: 400, message: "targetDivisionId is required when promoting students" };
    const sourceStandard = await academicDb().standard.findUnique({ where: { id: division.standardId }, select: { order: true } });
    const target = await academicDb().division.findFirst({
      where: { id: input.targetDivisionId, institutionId },
      select: { id: true, standardId: true, name: true, capacity: true, standard: { select: { order: true } } },
    });
    if (!target || !sourceStandard || target.standard.order !== sourceStandard.order + 1) {
      throw { status: 400, message: "targetDivisionId must belong to the next standard" };
    }
    targetDivision = { id: target.id, standardId: target.standardId, name: target.name, capacity: target.capacity };
  }

  const studentById = new Map(students.map((s) => [s.id, s]));
  const currentYear = await getCurrentAcademicYear(institutionId);

  const batchId = await academicDb().$transaction(async (tx) => {
    const batch = await tx.promotionBatch.create({
      data: {
        institutionId,
        fromStandardId: division.standardId,
        fromDivisionId: divisionId,
        toDivisionId: targetDivision?.id ?? null,
        academicYearId: currentYear.id,
        triggeredById: userId,
        triggeredByRole: actorRole,
      },
    });

    // PROMOTED/REPEATED students are moving into the year AFTER the one this
    // batch is closing out — not necessarily "whatever is currently marked
    // current", since promotion may run before or after an explicit rollover.
    // GRADUATED/WITHDRAWN students' terminal enrollment belongs to the
    // closing year itself (currentYear), since that's the year they left in.
    const nextYear = await getNextAcademicYear(institutionId, currentYear, tx);

    for (const o of input.outcomes) {
      const student = studentById.get(o.studentId)!;

      await tx.studentPromotionOutcome.create({
        data: {
          batchId: batch.id,
          studentId: o.studentId,
          institutionId,
          outcome: o.outcome,
          previousStandardId: student.standardId!,
          previousDivisionId: student.divisionId!,
          previousStatus: student.status,
        },
      });

      if (o.outcome === "PROMOTED" && targetDivision) {
        await tx.student.update({
          where: { id: o.studentId },
          data: { standardId: targetDivision.standardId, divisionId: targetDivision.id },
        });
      } else if (o.outcome === "GRADUATED") {
        await tx.student.update({ where: { id: o.studentId }, data: { status: "GRADUATED" } });
      } else if (o.outcome === "WITHDRAWN") {
        await tx.student.update({ where: { id: o.studentId }, data: { status: "WITHDRAWN" } });
      }
      // REPEATED: no student field changes

      const isTerminal = o.outcome === "GRADUATED" || o.outcome === "WITHDRAWN";
      const enrollmentDivisionId =
        o.outcome === "PROMOTED" && targetDivision ? targetDivision.id : student.divisionId!;
      const enrollmentStandardId =
        o.outcome === "PROMOTED" && targetDivision ? targetDivision.standardId : student.standardId!;
      const enrollmentStatus =
        o.outcome === "GRADUATED" ? "GRADUATED" : o.outcome === "WITHDRAWN" ? "WITHDRAWN" : "ACTIVE";
      // Terminal outcomes (leaving the institution) belong to the year they left
      // in; PROMOTED/REPEATED students belong to the year they're moving into.
      const enrollmentYearId = isTerminal ? currentYear.id : nextYear.id;

      try {
        await tx.studentEnrollment.create({
          data: {
            institutionId,
            studentId: o.studentId,
            academicYearId: enrollmentYearId,
            standardId: enrollmentStandardId,
            divisionId: enrollmentDivisionId,
            status: enrollmentStatus,
          },
        });
      } catch (err) {
        // StudentEnrollment is unique per (studentId, academicYearId). A REPEATED
        // student stays ACTIVE in this division, so a second batch for the same
        // division in the same academic year collides here. Throwing out of the
        // interactive transaction rolls the whole batch back.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw { status: 409, message: "This student already has an enrollment record for this academic year" };
        }
        throw err;
      }
    }

    return batch.id;
  });

  let warning: string | undefined;
  if (targetDivision && targetDivision.capacity !== null) {
    const newHeadcount = await academicDb().student.count({ where: { divisionId: targetDivision.id, institutionId, status: "ACTIVE" } });
    if (newHeadcount > targetDivision.capacity) {
      warning = `Target division ${targetDivision.name} is now at ${newHeadcount}/${targetDivision.capacity} capacity`;
    }
  }

  return { batchId, warning };
}

export async function undoPromotionBatch(batchId: string, institutionId: string): Promise<void> {
  const batch = await academicDb().promotionBatch.findFirst({
    where: { id: batchId, institutionId },
    include: { outcomes: true },
  });
  if (!batch) throw { status: 404, message: "Promotion batch not found" };
  if (batch.undoneAt) throw { status: 409, message: "This batch has already been undone" };
  const hoursSince = (Date.now() - batch.createdAt.getTime()) / (1000 * 60 * 60);
  if (hoursSince > 48) throw { status: 409, message: "The 48-hour undo window has expired" };

  await academicDb().$transaction(async (tx) => {
    // PROMOTED/REPEATED outcomes created their enrollment under the year AFTER
    // batch.academicYearId (see applyPromotionOutcomes); GRADUATED/WITHDRAWN
    // created theirs under batch.academicYearId itself. Look up (don't create)
    // that next year so undo doesn't spuriously bring a new year into existence.
    let nextYearId: string | null = null;
    if (batch.academicYearId) {
      const batchYear = await tx.academicYear.findUnique({ where: { id: batch.academicYearId } });
      if (batchYear) {
        const dayAfterEnd = new Date(batchYear.endDate.getTime() + 24 * 60 * 60 * 1000);
        const nextWindow = computeDefaultAcademicYearWindow(dayAfterEnd);
        const nextYear = await tx.academicYear.findFirst({ where: { institutionId, label: nextWindow.label } });
        nextYearId = nextYear?.id ?? null;
      }
    }

    for (const o of batch.outcomes) {
      await tx.student.update({
        where: { id: o.studentId },
        data: { standardId: o.previousStandardId, divisionId: o.previousDivisionId, status: o.previousStatus },
      });

      const isTerminal = o.outcome === "GRADUATED" || o.outcome === "WITHDRAWN";
      const enrollmentYearId = isTerminal ? batch.academicYearId : nextYearId;

      if (enrollmentYearId) {
        // Undo the StudentEnrollment row this outcome created, so the student is free to be
        // re-promoted within the same academic year without hitting the studentId+academicYearId
        // unique constraint, and so no stale/reverted enrollment data is left behind.
        await tx.studentEnrollment.deleteMany({
          where: { studentId: o.studentId, academicYearId: enrollmentYearId },
        });
      }
    }
    await tx.promotionBatch.update({ where: { id: batchId }, data: { undoneAt: new Date() } });
  });
}

export interface BatchSummary {
  id: string;
  academicYear: string;
  createdAt: string;
  undoneAt: string | null;
  fromStandard: { name: string };
  fromDivision: { name: string };
  toDivision: { name: string } | null;
  counts: { promoted: number; repeated: number; graduated: number; withdrawn: number };
}

export async function listPromotionBatches(
  institutionId: string,
  divisionIds?: string[]
): Promise<BatchSummary[]> {
  const batches = await academicDb().promotionBatch.findMany({
    where: {
      institutionId,
      ...(divisionIds ? { fromDivisionId: { in: divisionIds } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      outcomes: { select: { outcome: true } },
      academicYear: { select: { label: true } },
    },
  });

  const standardIds = new Set<string>();
  const divisionIdSet = new Set<string>();
  for (const b of batches) {
    standardIds.add(b.fromStandardId);
    divisionIdSet.add(b.fromDivisionId);
    if (b.toDivisionId) divisionIdSet.add(b.toDivisionId);
  }
  const [standards, divisions] = await Promise.all([
    academicDb().standard.findMany({ where: { id: { in: [...standardIds] } }, select: { id: true, name: true } }),
    academicDb().division.findMany({ where: { id: { in: [...divisionIdSet] } }, select: { id: true, name: true } }),
  ]);
  const standardMap = new Map(standards.map((s) => [s.id, s.name]));
  const divisionMap = new Map(divisions.map((d) => [d.id, d.name]));

  return batches.map((b) => {
    const counts = { promoted: 0, repeated: 0, graduated: 0, withdrawn: 0 };
    for (const o of b.outcomes) {
      if (o.outcome === "PROMOTED") counts.promoted++;
      else if (o.outcome === "REPEATED") counts.repeated++;
      else if (o.outcome === "GRADUATED") counts.graduated++;
      else counts.withdrawn++;
    }
    return {
      id: b.id,
      academicYear: b.academicYear.label,
      createdAt: b.createdAt.toISOString(),
      undoneAt: b.undoneAt?.toISOString() ?? null,
      fromStandard: { name: standardMap.get(b.fromStandardId) ?? "" },
      fromDivision: { name: divisionMap.get(b.fromDivisionId) ?? "" },
      toDivision: b.toDivisionId ? { name: divisionMap.get(b.toDivisionId) ?? "" } : null,
      counts,
    };
  });
}
