import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { SubmitOutcomesInput } from "./promotion.schema";

export interface PreviewStudent { id: string; studentId: string; name: string | null; rollNo: string | null }
export interface PreviewTarget { divisionId: string; name: string; currentHeadcount: number; capacity: number | null }
export interface PreviewData {
  sourceDivision: { id: string; name: string; standardName: string };
  students: PreviewStudent[];
  isHighestStandard: boolean;
  targets: PreviewTarget[];
}

function getAcademicYear(): string {
  const now = new Date();
  const month = now.getMonth(); // 0-indexed
  const year = now.getFullYear();
  if (month >= 5) return `${year}-${String(year + 1).slice(2)}`;
  return `${year - 1}-${String(year).slice(2)}`;
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
  const academicYear = getAcademicYear();

  const batchId = await academicDb().$transaction(async (tx) => {
    const batch = await tx.promotionBatch.create({
      data: {
        institutionId,
        fromStandardId: division.standardId,
        fromDivisionId: divisionId,
        toDivisionId: targetDivision?.id ?? null,
        academicYear,
        triggeredById: userId,
        triggeredByRole: actorRole,
      },
    });

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
    for (const o of batch.outcomes) {
      await tx.student.update({
        where: { id: o.studentId },
        data: { standardId: o.previousStandardId, divisionId: o.previousDivisionId, status: o.previousStatus },
      });
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
      academicYear: b.academicYear,
      createdAt: b.createdAt.toISOString(),
      undoneAt: b.undoneAt?.toISOString() ?? null,
      fromStandard: { name: standardMap.get(b.fromStandardId) ?? "" },
      fromDivision: { name: divisionMap.get(b.fromDivisionId) ?? "" },
      toDivision: b.toDivisionId ? { name: divisionMap.get(b.toDivisionId) ?? "" } : null,
      counts,
    };
  });
}
