import { Response, NextFunction } from "express";
import crypto from "crypto";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import {
  initMarksheetSchema,
  addColumnSchema,
  editColumnSchema,
  reorderColumnsSchema,
  subjectConfigSchema,
  bulkScoresSchema,
  addGradedSubjectSchema,
  editGradedSubjectSchema,
  reorderGradedSubjectsSchema,
  gradedSectionTitleSchema,
  bulkGradedScoresSchema,
} from "./marksheet.schema";

// ── Internal helpers ──────────────────────────────────────────────────────────

async function getTeacherId(userId: string, institutionId: string): Promise<string> {
  const teacher = await prisma.teacher.findFirst({
    where: { userId, institutionId },
    select: { id: true },
  });
  if (!teacher) throw { status: 404, message: "Teacher profile not found" };
  return teacher.id;
}

async function assertClassTeacher(
  teacherId: string,
  divisionId: string,
  institutionId: string
): Promise<void> {
  const division = await prisma.division.findFirst({
    where: { id: divisionId, institutionId },
    select: { classTeacherId: true },
  });
  if (!division) throw { status: 404, message: "Division not found" };
  if (!division.classTeacherId) {
    throw { status: 403, message: "No class teacher assigned to this division yet. Admin must assign one first." };
  }
  if (division.classTeacherId !== teacherId) {
    throw { status: 403, message: "Only the class teacher can perform this action" };
  }
}

async function assertSubjectTeacher(
  teacherId: string,
  divisionId: string,
  subjectId: string,
  institutionId: string
): Promise<void> {
  const assignment = await prisma.divisionAssignment.findFirst({
    where: { teacherId, divisionId, subjectId, institutionId },
    select: { id: true },
  });
  if (!assignment) {
    throw { status: 403, message: "You are not assigned to teach this subject in this division" };
  }
}

async function isClassTeacherOf(
  teacherId: string,
  divisionId: string,
  institutionId: string
): Promise<boolean> {
  const division = await prisma.division.findFirst({
    where: { id: divisionId, institutionId },
    select: { classTeacherId: true },
  });
  return division?.classTeacherId === teacherId;
}

function getCurrentAcademicYear(): string {
  const now = new Date();
  const month = now.getMonth(); // 0-indexed, June = 5
  const year = now.getFullYear();
  const startYear = month >= 5 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}

async function fetchMarksheetFull(
  marksheetId: string,
  institutionId: string,
  callerTeacherId: string,
  isClassTeacher: boolean,
  mySubjectIds: string[]
) {
  const [marksheet, examColumns, scores, gradedSubjects, gradedScores, students] =
    await Promise.all([
      prisma.marksheet.findUnique({
        where: { id: marksheetId },
        select: {
          id: true,
          academicYear: true,
          status: true,
          shareToken: true,
          gradedSectionTitle: true,
          subjectConfigs: {
            select: { subjectId: true, passingMarks: true, gradeScale: true },
          },
        },
      }),
      prisma.marksheetExamColumn.findMany({
        where: { marksheetId, institutionId },
        orderBy: [{ subjectId: "asc" }, { order: "asc" }],
        select: { id: true, subjectId: true, name: true, maxMarks: true, examDate: true, order: true },
      }),
      prisma.marksheetScore.findMany({
        where: { marksheetId, institutionId },
        select: { examColumnId: true, studentId: true, score: true, isAbsent: true },
      }),
      prisma.marksheetGradedSubject.findMany({
        where: { marksheetId, institutionId },
        orderBy: { order: "asc" },
        select: { id: true, name: true, order: true },
      }),
      prisma.marksheetGradedScore.findMany({
        where: { marksheetId, institutionId },
        select: { gradedSubjectId: true, studentId: true, term1Grade: true, term2Grade: true },
      }),
      prisma.student.findMany({
        where: { institutionId, division: { marksheets: { some: { id: marksheetId } } } },
        include: { user: { select: { name: true } } },
        orderBy: [{ rollNo: "asc" }, { joinedAt: "asc" }],
      }),
    ]);

  if (!marksheet) throw { status: 404, message: "Marksheet not found" };

  // Group exam columns by subjectId
  const columnsBySubject: Record<string, typeof examColumns> = {};
  for (const col of examColumns) {
    if (!isClassTeacher && !mySubjectIds.includes(col.subjectId)) continue;
    if (!columnsBySubject[col.subjectId]) columnsBySubject[col.subjectId] = [];
    columnsBySubject[col.subjectId].push(col);
  }

  // Build column ID set for filtering (subject teachers only see their columns)
  const visibleColumnIds = new Set(examColumns
    .filter(col => isClassTeacher || mySubjectIds.includes(col.subjectId))
    .map(col => col.id));

  // Group scores by examColumnId → studentId
  const scoreMap: Record<string, Record<string, { score: number | null; isAbsent: boolean }>> = {};
  for (const sc of scores) {
    if (!visibleColumnIds.has(sc.examColumnId)) continue;
    if (!scoreMap[sc.examColumnId]) scoreMap[sc.examColumnId] = {};
    scoreMap[sc.examColumnId][sc.studentId] = { score: sc.score, isAbsent: sc.isAbsent };
  }

  // Graded scores only visible to class teacher
  const gradedScoreMap: Record<string, Record<string, { term1Grade: string | null; term2Grade: string | null }>> = {};
  if (isClassTeacher) {
    for (const gs of gradedScores) {
      if (!gradedScoreMap[gs.gradedSubjectId]) gradedScoreMap[gs.gradedSubjectId] = {};
      gradedScoreMap[gs.gradedSubjectId][gs.studentId] = {
        term1Grade: gs.term1Grade,
        term2Grade: gs.term2Grade,
      };
    }
  }

  return {
    marksheet: {
      id: marksheet.id,
      academicYear: marksheet.academicYear,
      status: marksheet.status,
      shareToken: marksheet.shareToken,
      gradedSectionTitle: marksheet.gradedSectionTitle,
    },
    subjectConfigs: marksheet.subjectConfigs,
    examColumns: columnsBySubject,
    scores: scoreMap,
    gradedSubjects: isClassTeacher ? gradedSubjects : [],
    gradedScores: gradedScoreMap,
    students: students.map((s) => ({
      id: s.id,
      name: s.user.name,
      rollNo: s.rollNo ?? "",
    })),
  };
}

// ── POST /division/:divisionId/init ──────────────────────────────────────────

export async function initMarksheet(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const divisionId = req.params.divisionId as string;
    const teacherId = await getTeacherId(userId, institutionId);
    await assertClassTeacher(teacherId, divisionId, institutionId);

    const { academicYear } = initMarksheetSchema.parse(req.body);

    // Check not already initialized
    const existing = await prisma.marksheet.findUnique({
      where: { divisionId_academicYear: { divisionId, academicYear } },
      select: { id: true },
    });
    if (existing) {
      res.status(409).json({ success: false, error: "Marksheet already exists for this division and academic year" });
      return;
    }

    // Fetch all subjects for this division's standard
    const division = await prisma.division.findFirst({
      where: { id: divisionId, institutionId },
      include: {
        standard: {
          include: { subjects: { orderBy: { order: "asc" } } },
        },
      },
    });
    if (!division) {
      res.status(404).json({ success: false, error: "Division not found" });
      return;
    }

    const subjects = division.standard.subjects;
    const shareToken = crypto.randomUUID();

    const marksheet = await prisma.$transaction(async (tx) => {
      const ms = await tx.marksheet.create({
        data: {
          institutionId,
          divisionId,
          createdByTeacherId: teacherId,
          academicYear,
          shareToken,
        },
      });
      // Initialize MarksheetSubjectConfig for every subject in the standard
      if (subjects.length > 0) {
        await tx.marksheetSubjectConfig.createMany({
          data: subjects.map((sub) => ({
            marksheetId: ms.id,
            subjectId: sub.id,
            institutionId,
            passingMarks: 0,
            gradeScale: [],
          })),
        });
      }
      return ms;
    });

    res.status(201).json({ success: true, data: { marksheetId: marksheet.id, shareToken } });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── GET /division/:divisionId ─────────────────────────────────────────────────

export async function getDivisionMarksheet(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const divisionId = req.params.divisionId as string;
    const academicYear = (req.query.academicYear as string) || getCurrentAcademicYear();

    const teacherId = await getTeacherId(userId, institutionId);

    // Verify teacher is assigned to this division in any capacity
    const assignment = await prisma.divisionAssignment.findFirst({
      where: { divisionId, teacherId, institutionId },
      select: { id: true, subjectId: true },
    });
    if (!assignment) {
      res.status(403).json({ success: false, error: "Not assigned to this division" });
      return;
    }

    const marksheet = await prisma.marksheet.findUnique({
      where: { divisionId_academicYear: { divisionId, academicYear } },
      select: { id: true },
    });
    if (!marksheet) {
      res.status(404).json({ success: false, error: "Marksheet not initialized for this division and academic year" });
      return;
    }

    const isClassTeacher = await isClassTeacherOf(teacherId, divisionId, institutionId);

    // Collect all subject IDs this teacher is assigned to in this division
    const allAssignments = await prisma.divisionAssignment.findMany({
      where: { divisionId, teacherId, institutionId },
      select: { subjectId: true },
    });
    const mySubjectIds = allAssignments
      .map((a) => a.subjectId)
      .filter((id): id is string => id !== null);

    const data = await fetchMarksheetFull(marksheet.id, institutionId, teacherId, isClassTeacher, mySubjectIds);
    res.json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}
