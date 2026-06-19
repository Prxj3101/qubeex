import { Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";

// ── GET /api/admin/marksheet ──────────────────────────────────────────────────

export async function adminListMarksheets(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }

    const { divisionId, standardId, academicYear } = req.query as {
      divisionId?: string;
      standardId?: string;
      academicYear?: string;
    };

    const marksheets = await prisma.marksheet.findMany({
      where: {
        institutionId,
        ...(divisionId && { divisionId }),
        ...(standardId && { division: { standardId } }),
        ...(academicYear && { academicYear }),
      },
      include: {
        division: { include: { standard: true } },
        createdBy: { include: { user: { select: { name: true } } } },
        _count: { select: { examColumns: true, scores: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      success: true,
      data: marksheets.map((m) => ({
        id: m.id,
        academicYear: m.academicYear,
        status: m.status,
        shareToken: m.shareToken,
        divisionId: m.divisionId,
        divisionName: m.division.name,
        standardName: m.division.standard.name,
        createdByName: m.createdBy.user.name,
        examColumnCount: m._count.examColumns,
        scoreCount: m._count.scores,
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/admin/marksheet/division/:divisionId ─────────────────────────────

export async function adminGetDivisionMarksheet(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const divisionId = req.params.divisionId as string;
    const academicYear = (req.query.academicYear as string) || getCurrentAcademicYear();

    const marksheet = await prisma.marksheet.findUnique({
      where: { divisionId_academicYear: { divisionId, academicYear } },
      select: { id: true, institutionId: true },
    });
    if (!marksheet || marksheet.institutionId !== institutionId) {
      res.status(404).json({ success: false, error: "Marksheet not found" });
      return;
    }

    const [ms, examColumns, scores, gradedSubjects, gradedScores, students] = await Promise.all([
      prisma.marksheet.findUnique({
        where: { id: marksheet.id },
        select: {
          id: true, academicYear: true, status: true, shareToken: true, gradedSectionTitle: true,
          subjectConfigs: { select: { subjectId: true, passingMarks: true, gradeScale: true } },
        },
      }),
      prisma.marksheetExamColumn.findMany({
        where: { marksheetId: marksheet.id, institutionId },
        orderBy: [{ subjectId: "asc" }, { order: "asc" }],
        select: { id: true, subjectId: true, name: true, maxMarks: true, examDate: true, order: true },
      }),
      prisma.marksheetScore.findMany({
        where: { marksheetId: marksheet.id },
        select: { examColumnId: true, studentId: true, score: true, isAbsent: true },
      }),
      prisma.marksheetGradedSubject.findMany({
        where: { marksheetId: marksheet.id },
        orderBy: { order: "asc" },
        select: { id: true, name: true, order: true },
      }),
      prisma.marksheetGradedScore.findMany({
        where: { marksheetId: marksheet.id },
        select: { gradedSubjectId: true, studentId: true, term1Grade: true, term2Grade: true },
      }),
      prisma.student.findMany({
        where: { divisionId, institutionId },
        include: { user: { select: { name: true } } },
        orderBy: [{ rollNo: "asc" }, { joinedAt: "asc" }],
      }),
    ]);

    const columnsBySubject: Record<string, typeof examColumns> = {};
    for (const col of examColumns) {
      if (!columnsBySubject[col.subjectId]) columnsBySubject[col.subjectId] = [];
      columnsBySubject[col.subjectId].push(col);
    }

    const scoreMap: Record<string, Record<string, { score: number | null; isAbsent: boolean }>> = {};
    for (const sc of scores) {
      if (!scoreMap[sc.examColumnId]) scoreMap[sc.examColumnId] = {};
      scoreMap[sc.examColumnId][sc.studentId] = { score: sc.score, isAbsent: sc.isAbsent };
    }

    const gradedScoreMap: Record<string, Record<string, { term1Grade: string | null; term2Grade: string | null }>> = {};
    for (const gs of gradedScores) {
      if (!gradedScoreMap[gs.gradedSubjectId]) gradedScoreMap[gs.gradedSubjectId] = {};
      gradedScoreMap[gs.gradedSubjectId][gs.studentId] = { term1Grade: gs.term1Grade, term2Grade: gs.term2Grade };
    }

    res.json({
      success: true,
      data: {
        marksheet: {
          id: ms!.id, academicYear: ms!.academicYear, status: ms!.status,
          shareToken: ms!.shareToken, gradedSectionTitle: ms!.gradedSectionTitle,
        },
        subjectConfigs: ms!.subjectConfigs,
        examColumns: columnsBySubject,
        scores: scoreMap,
        gradedSubjects,
        gradedScores: gradedScoreMap,
        students: students.map((s) => ({ id: s.id, name: s.user.name, rollNo: s.rollNo ?? "" })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/admin/campus/divisions/:divisionId/class-teacher ───────────────

export async function assignClassTeacher(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const divisionId = req.params.divisionId as string;
    const bodySchema = z.object({ teacherId: z.string().uuid().nullable() });
    const parseResult = bodySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ success: false, error: "teacherId must be a UUID or null" });
      return;
    }
    const { teacherId } = parseResult.data;

    const division = await prisma.division.findFirst({
      where: { id: divisionId, institutionId },
      select: { id: true },
    });
    if (!division) { res.status(404).json({ success: false, error: "Division not found" }); return; }

    if (teacherId !== null) {
      const teacher = await prisma.teacher.findFirst({
        where: { id: teacherId, institutionId },
        select: { id: true },
      });
      if (!teacher) { res.status(404).json({ success: false, error: "Teacher not found" }); return; }
    }

    await prisma.division.update({
      where: { id: divisionId },
      data: { classTeacherId: teacherId ?? null },
    });

    res.json({ success: true, data: { divisionId, classTeacherId: teacherId ?? null } });
  } catch (err) {
    next(err);
  }
}

function getCurrentAcademicYear(): string {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const startYear = month >= 5 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}
