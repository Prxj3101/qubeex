import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError, NotFoundError, ForbiddenError, ConflictError } from "../../utils/errors";
import { promoteStudentsSchema } from "./promotion.schema";
import { getAcademicYear } from "./promotion.utils";
import { logAudit } from "../../services/audit.service";

async function assertClassTeacher(
  userId: string,
  institutionId: string,
  divisionId: string
): Promise<string> {
  const teacher = await prisma.teacher.findFirst({
    where: { userId, institutionId },
    select: { id: true },
  });
  if (!teacher) throw new NotFoundError("Teacher profile not found");

  const assignment = await prisma.divisionAssignment.findFirst({
    where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
    select: { id: true },
  });
  if (!assignment) throw new ForbiddenError("Only the class teacher can perform this action");

  return teacher.id;
}

export const getPromotionPreview = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const divisionId = req.params.divisionId as string;

    const division = await prisma.division.findFirst({
      where: { id: divisionId, institutionId },
      select: {
        id: true,
        name: true,
        standardId: true,
        standard: { select: { name: true, order: true } },
      },
    });
    if (!division) throw new NotFoundError("Division not found");

    if (user.role === "TEACHER") {
      await assertClassTeacher(user.userId, institutionId, divisionId);
    }

    const students = await prisma.student.findMany({
      where: { divisionId, institutionId, status: "ACTIVE" },
      select: { id: true, studentId: true, rollNo: true, user: { select: { name: true } } },
      orderBy: { rollNo: "asc" },
    });

    const nextStandard = await prisma.standard.findFirst({
      where: { institutionId, order: division.standard.order + 1 },
      select: { id: true },
    });

    const baseData = {
      sourceDivision: { id: division.id, name: division.name, standardName: division.standard.name },
      students: students.map((s) => ({ id: s.id, studentId: s.studentId, name: s.user.name, rollNo: s.rollNo })),
    };

    if (!nextStandard) {
      res.json({ success: true, data: { ...baseData, isGraduationEligible: true } });
      return;
    }

    const targetDivisions = await prisma.division.findMany({
      where: { standardId: nextStandard.id, institutionId },
      select: {
        id: true,
        name: true,
        capacity: true,
        _count: { select: { students: { where: { status: "ACTIVE" } } } },
      },
    });

    res.json({
      success: true,
      data: {
        ...baseData,
        isGraduationEligible: false,
        targets: targetDivisions.map((d) => ({
          divisionId: d.id,
          name: d.name,
          currentHeadcount: d._count.students,
          capacity: d.capacity,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const promoteStudents = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const divisionId = req.params.divisionId as string;
    const data = promoteStudentsSchema.parse(req.body);

    const division = await prisma.division.findFirst({
      where: { id: divisionId, institutionId },
      select: { id: true, standardId: true, standard: { select: { order: true } } },
    });
    if (!division) throw new NotFoundError("Division not found");

    if (user.role === "TEACHER") {
      await assertClassTeacher(user.userId, institutionId, divisionId);
    }

    const students = await prisma.student.findMany({
      where: { id: { in: data.studentIds }, divisionId, institutionId, status: "ACTIVE" },
      select: { id: true, standardId: true, divisionId: true, status: true },
    });
    if (students.length !== data.studentIds.length) {
      const foundIds = new Set(students.map((s) => s.id));
      const missing = data.studentIds.filter((id) => !foundIds.has(id));
      throw new BadRequestError(`Students not found in this division or not active: ${missing.join(", ")}`);
    }

    const nextStandard = await prisma.standard.findFirst({
      where: { institutionId, order: division.standard.order + 1 },
      select: { id: true },
    });

    let toStandardId: string | null = null;
    let toDivisionId: string | null = null;
    let warning: string | undefined;

    if (data.action === "PROMOTE") {
      if (!nextStandard) throw new BadRequestError("This is already the highest standard; use GRADUATE instead");

      const targetDivision = await prisma.division.findFirst({
        where: { id: data.targetDivisionId, institutionId, standardId: nextStandard.id },
        select: { id: true, capacity: true, _count: { select: { students: { where: { status: "ACTIVE" } } } } },
      });
      if (!targetDivision) throw new BadRequestError("Target division does not belong to the next standard");

      toStandardId = nextStandard.id;
      toDivisionId = targetDivision.id;

      const resultingHeadcount = targetDivision._count.students + students.length;
      if (targetDivision.capacity != null && resultingHeadcount > targetDivision.capacity) {
        warning = `Target division is now at ${resultingHeadcount}/${targetDivision.capacity} capacity`;
      }
    } else {
      if (nextStandard) throw new BadRequestError("This is not the highest standard; use PROMOTE instead");
    }

    const academicYear = getAcademicYear();
    // promoteStudentsSchema uses "PROMOTE" | "GRADUATE"; the Prisma PromotionOutcome
    // enum (used by PromotionBatch.action and StudentEnrollment.outcome) uses the
    // past-tense forms "PROMOTED" | "GRADUATED". Map between them explicitly.
    const outcome: "PROMOTED" | "GRADUATED" = data.action === "PROMOTE" ? "PROMOTED" : "GRADUATED";
    const previousState = students.map((s) => ({
      studentId: s.id,
      standardId: s.standardId,
      divisionId: s.divisionId,
      status: s.status,
    }));

    const batch = await prisma.$transaction(async (tx) => {
      if (data.action === "PROMOTE") {
        await tx.student.updateMany({
          where: { id: { in: data.studentIds }, institutionId },
          data: { standardId: toStandardId!, divisionId: toDivisionId! },
        });
      } else {
        await tx.student.updateMany({
          where: { id: { in: data.studentIds }, institutionId },
          data: { status: "GRADUATED" },
        });
      }

      const createdBatch = await tx.promotionBatch.create({
        data: {
          institutionId,
          fromStandardId: division.standardId,
          fromDivisionId: division.id,
          toStandardId,
          toDivisionId,
          academicYear,
          action: outcome,
          studentCount: students.length,
          previousState,
          triggeredById: user.userId,
          triggeredByRole: user.role,
        },
      });

      await tx.studentEnrollment.createMany({
        data: students.map((s) => ({
          studentId: s.id,
          institutionId,
          academicYear,
          standardId: division.standardId,
          divisionId: division.id,
          outcome,
          promotionBatchId: createdBatch.id,
        })),
      });

      return createdBatch;
    });

    logAudit("STUDENTS_PROMOTED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId,
      details: `${students.length} student(s) ${data.action === "PROMOTE" ? "promoted" : "graduated"} from division ${division.id}`,
      metadata: { batchId: batch.id, action: data.action, count: students.length, fromDivisionId: division.id, toDivisionId },
      category: "ADMIN_ACTION",
      severity: "INFO",
    });

    res.status(201).json({
      success: true,
      data: { batchId: batch.id, promotedCount: students.length, action: data.action },
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    next(error);
  }
};

export const undoPromotionBatch = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const batchId = req.params.batchId as string;
    const batch = await prisma.promotionBatch.findFirst({ where: { id: batchId, institutionId } });
    if (!batch) throw new NotFoundError("Promotion batch not found");

    if (user.role === "TEACHER") {
      await assertClassTeacher(user.userId, institutionId, batch.fromDivisionId);
    }

    if (batch.undoneAt) throw new ConflictError("This promotion batch has already been undone");

    const hoursSinceCreation = (Date.now() - batch.createdAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceCreation > 24) {
      throw new ConflictError("This promotion batch is more than 24 hours old and can no longer be undone");
    }

    const previousState = batch.previousState as Array<{
      studentId: string;
      standardId: string | null;
      divisionId: string | null;
      status: "ACTIVE" | "INACTIVE" | "GRADUATED";
    }>;

    await prisma.$transaction(async (tx) => {
      for (const entry of previousState) {
        await tx.student.updateMany({
          where: { id: entry.studentId, institutionId },
          data: { standardId: entry.standardId, divisionId: entry.divisionId, status: entry.status },
        });
      }
      await tx.studentEnrollment.deleteMany({ where: { promotionBatchId: batch.id } });
      await tx.promotionBatch.update({ where: { id: batch.id }, data: { undoneAt: new Date() } });
    });

    logAudit("STUDENT_PROMOTION_UNDONE", {
      userId: user.userId,
      actorRole: user.role,
      institutionId,
      details: `Promotion batch ${batch.id} undone (${batch.studentCount} student(s))`,
      metadata: { batchId: batch.id },
      category: "ADMIN_ACTION",
      severity: "WARNING",
    });

    res.json({ success: true, data: { batchId: batch.id, restoredCount: previousState.length } });
  } catch (error) {
    next(error);
  }
};

export const listPromotionBatches = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const divisionId = req.query.divisionId as string | undefined;

    const batches = await prisma.promotionBatch.findMany({
      where: { institutionId, ...(divisionId ? { fromDivisionId: divisionId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    res.json({ success: true, data: batches });
  } catch (error) {
    next(error);
  }
};
