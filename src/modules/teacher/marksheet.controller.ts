import { Response, NextFunction } from "express";
import crypto from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require("pdfkit");
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

// ── R2 client ─────────────────────────────────────────────────────────────────

function getR2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT!,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

async function generateMarksheetPdf(params: {
  divisionName: string;
  standardName: string;
  institutionName: string;
  academicYear: string;
  subjects: { id: string; name: string; code: string }[];
  examColumnsBySubject: Record<string, { id: string; name: string; maxMarks: number }[]>;
  students: { id: string; name: string; rollNo: string }[];
  scoreMap: Record<string, Record<string, { score: number | null; isAbsent: boolean }>>;
  gradedSubjects: { id: string; name: string }[];
  gradedScoreMap: Record<string, Record<string, { term1Grade: string | null; term2Grade: string | null }>>;
  gradedSectionTitle: string;
}): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
  const chunks: Buffer[] = [];

  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Title
    doc.fontSize(14).font("Helvetica-Bold")
      .text(`${params.institutionName} — Marksheet`, { align: "center" });
    doc.fontSize(10).font("Helvetica").fillColor("#555")
      .text(`${params.standardName} - ${params.divisionName} | Academic Year: ${params.academicYear}`, { align: "center" });
    doc.moveDown(0.8);

    // Build header row
    const COL_W = 55;
    const NAME_W = 120;
    const ROLL_W = 40;
    const startX = doc.page.margins.left;
    let y = doc.y;

    const headerCols: string[] = [];
    params.subjects.forEach((sub) => {
      const cols = params.examColumnsBySubject[sub.id] ?? [];
      cols.forEach((col) => headerCols.push(`${sub.code}\n${col.name}\n/${col.maxMarks}`));
      headerCols.push(`${sub.code}\nTotal`);
      headerCols.push(`${sub.code}\n%`);
    });
    if (params.gradedSubjects.length > 0) {
      params.gradedSubjects.forEach((gs) => {
        headerCols.push(`${gs.name}\nT1`);
        headerCols.push(`${gs.name}\nT2`);
      });
    }
    headerCols.push("Grand\nTotal");
    headerCols.push("Grand\n%");
    headerCols.push("Grade");

    const totalWidth = ROLL_W + NAME_W + headerCols.length * COL_W;

    // Draw header background
    doc.rect(startX, y, totalWidth, 32).fill("#E8DDD0");
    doc.fillColor("#2A1F10").font("Helvetica-Bold").fontSize(7);
    doc.text("Roll", startX + 2, y + 4, { width: ROLL_W - 4 });
    doc.text("Student Name", startX + ROLL_W + 2, y + 4, { width: NAME_W - 4 });
    headerCols.forEach((label, i) => {
      doc.text(label, startX + ROLL_W + NAME_W + i * COL_W + 2, y + 4, { width: COL_W - 4 });
    });
    y += 32;

    // Draw rows
    doc.font("Helvetica").fontSize(7);
    params.students.forEach((student, si) => {
      if (y > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage({ layout: "landscape", size: "A4", margin: 30 });
        y = doc.page.margins.top;
      }
      const rowBg = si % 2 === 0 ? "#FAF5EE" : "#F5EFE5";
      doc.rect(startX, y, totalWidth, 18).fill(rowBg);
      doc.fillColor("#2A1F10");
      doc.text(student.rollNo, startX + 2, y + 4, { width: ROLL_W - 4 });
      doc.text(student.name, startX + ROLL_W + 2, y + 4, { width: NAME_W - 4, ellipsis: true });

      let colIdx = 0;
      let grandScored = 0, grandMax = 0;

      params.subjects.forEach((sub) => {
        const cols = params.examColumnsBySubject[sub.id] ?? [];
        let subScored = 0, subMax = 0;
        cols.forEach((col) => {
          const entry = params.scoreMap[col.id]?.[student.id];
          const score = entry?.score ?? null;
          const absent = entry?.isAbsent ?? false;
          const cellText = absent ? "AB" : score !== null ? String(score) : "—";
          doc.text(cellText, startX + ROLL_W + NAME_W + colIdx * COL_W + 2, y + 4, { width: COL_W - 4 });
          if (score !== null) { subScored += score; subMax += col.maxMarks; }
          else if (!absent) { subMax += col.maxMarks; }
          colIdx++;
        });
        const subTotal = `${subScored}/${subMax}`;
        const subPct = subMax > 0 ? `${Math.round((subScored / subMax) * 100)}%` : "—";
        doc.text(subTotal, startX + ROLL_W + NAME_W + colIdx * COL_W + 2, y + 4, { width: COL_W - 4 });
        colIdx++;
        doc.text(subPct, startX + ROLL_W + NAME_W + colIdx * COL_W + 2, y + 4, { width: COL_W - 4 });
        colIdx++;
        grandScored += subScored;
        grandMax += subMax;
      });

      params.gradedSubjects.forEach((gs) => {
        const entry = params.gradedScoreMap[gs.id]?.[student.id];
        doc.text(entry?.term1Grade ?? "—", startX + ROLL_W + NAME_W + colIdx * COL_W + 2, y + 4, { width: COL_W - 4 });
        colIdx++;
        doc.text(entry?.term2Grade ?? "—", startX + ROLL_W + NAME_W + colIdx * COL_W + 2, y + 4, { width: COL_W - 4 });
        colIdx++;
      });

      const grandPct = grandMax > 0 ? Math.round((grandScored / grandMax) * 100) : null;
      const gradeLabel = grandPct === null ? "—" : grandPct >= 75 ? "A" : grandPct >= 60 ? "B" : grandPct >= 45 ? "C" : grandPct >= 35 ? "D" : "F";
      doc.text(`${grandScored}/${grandMax}`, startX + ROLL_W + NAME_W + colIdx * COL_W + 2, y + 4, { width: COL_W - 4 });
      colIdx++;
      doc.text(grandPct !== null ? `${grandPct}%` : "—", startX + ROLL_W + NAME_W + colIdx * COL_W + 2, y + 4, { width: COL_W - 4 });
      colIdx++;
      doc.text(gradeLabel, startX + ROLL_W + NAME_W + colIdx * COL_W + 2, y + 4, { width: COL_W - 4 });

      y += 18;
    });

    doc.end();
  });
}

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
  // App-wide convention: the class teacher is the DivisionAssignment with subjectId = null.
  const division = await prisma.division.findFirst({
    where: { id: divisionId, institutionId },
    select: { id: true },
  });
  if (!division) throw { status: 404, message: "Division not found" };
  const classTeacherAssignment = await prisma.divisionAssignment.findFirst({
    where: { divisionId, teacherId, institutionId, subjectId: null },
    select: { id: true },
  });
  if (!classTeacherAssignment) {
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
  // App-wide convention: the class teacher is the DivisionAssignment with subjectId = null.
  const classTeacherAssignment = await prisma.divisionAssignment.findFirst({
    where: { divisionId, teacherId, institutionId, subjectId: null },
    select: { id: true },
  });
  return !!classTeacherAssignment;
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
          institutionId: true,
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

  if (!marksheet || marksheet.institutionId !== institutionId) {
    throw { status: 404, message: "Marksheet not found" };
  }

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
    subjectConfigs: isClassTeacher
      ? marksheet.subjectConfigs
      : marksheet.subjectConfigs.filter(c => mySubjectIds.includes(c.subjectId)),
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
    const { academicYear } = initMarksheetSchema.parse(req.body);

    // Single division fetch with subjects — guard handled via DivisionAssignment below
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
    // App-wide convention: the class teacher is the DivisionAssignment with subjectId = null.
    const classTeacherAssignment = await prisma.divisionAssignment.findFirst({
      where: { divisionId, teacherId, institutionId, subjectId: null },
      select: { id: true },
    });
    if (!classTeacherAssignment) {
      res.status(403).json({ success: false, error: "Only the class teacher can perform this action" });
      return;
    }

    // Check not already initialized
    const existing = await prisma.marksheet.findUnique({
      where: { divisionId_academicYear: { divisionId, academicYear } },
      select: { id: true },
    });
    if (existing) {
      res.status(409).json({ success: false, error: "Marksheet already exists for this division and academic year" });
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

// ── POST /:id/columns ─────────────────────────────────────────────────────────

export async function addColumn(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const marksheetId = req.params.id as string;
    const teacherId = await getTeacherId(userId, institutionId);

    const marksheet = await prisma.marksheet.findFirst({
      where: { id: marksheetId, institutionId },
      select: { id: true, divisionId: true },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }

    const { subjectId, name, maxMarks, examDate } = addColumnSchema.parse(req.body);
    const isClassTeacher = await isClassTeacherOf(teacherId, marksheet.divisionId, institutionId);

    if (!isClassTeacher) {
      // Subject teacher — must be assigned to this subject in this division
      await assertSubjectTeacher(teacherId, marksheet.divisionId, subjectId, institutionId);
    }

    // Determine next order value
    const maxOrder = await prisma.marksheetExamColumn.aggregate({
      where: { marksheetId, subjectId },
      _max: { order: true },
    });
    const nextOrder = (maxOrder._max.order ?? -1) + 1;

    const column = await prisma.marksheetExamColumn.create({
      data: {
        marksheetId,
        subjectId,
        institutionId,
        name,
        maxMarks,
        examDate: examDate ? new Date(examDate) : null,
        order: nextOrder,
        createdByTeacherId: teacherId,
      },
      select: { id: true, subjectId: true, name: true, maxMarks: true, examDate: true, order: true },
    });

    res.status(201).json({ success: true, data: column });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── PATCH /:id/columns/:colId ─────────────────────────────────────────────────

export async function editColumn(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const { id: marksheetId, colId } = req.params as { id: string; colId: string };
    const teacherId = await getTeacherId(userId, institutionId);

    const column = await prisma.marksheetExamColumn.findFirst({
      where: { id: colId, marksheetId, institutionId },
      select: { id: true, subjectId: true, marksheet: { select: { divisionId: true } } },
    });
    if (!column) { res.status(404).json({ success: false, error: "Column not found" }); return; }

    const isClassTeacher = await isClassTeacherOf(teacherId, column.marksheet.divisionId, institutionId);
    if (!isClassTeacher) {
      await assertSubjectTeacher(teacherId, column.marksheet.divisionId, column.subjectId, institutionId);
    }

    const data = editColumnSchema.parse(req.body);
    const updated = await prisma.marksheetExamColumn.update({
      where: { id: colId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.maxMarks !== undefined && { maxMarks: data.maxMarks }),
        ...(data.examDate !== undefined && { examDate: data.examDate ? new Date(data.examDate) : null }),
      },
      select: { id: true, subjectId: true, name: true, maxMarks: true, examDate: true, order: true },
    });

    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── DELETE /:id/columns/:colId ────────────────────────────────────────────────

export async function deleteColumn(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const { id: marksheetId, colId } = req.params as { id: string; colId: string };
    const teacherId = await getTeacherId(userId, institutionId);

    const column = await prisma.marksheetExamColumn.findFirst({
      where: { id: colId, marksheetId, institutionId },
      select: { id: true, subjectId: true, marksheet: { select: { divisionId: true } } },
    });
    if (!column) { res.status(404).json({ success: false, error: "Column not found" }); return; }

    const isClassTeacher = await isClassTeacherOf(teacherId, column.marksheet.divisionId, institutionId);
    if (!isClassTeacher) {
      await assertSubjectTeacher(teacherId, column.marksheet.divisionId, column.subjectId, institutionId);
    }

    // Cascade deletes scores via onDelete: Cascade on MarksheetScore
    await prisma.marksheetExamColumn.delete({ where: { id: colId } });

    res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── PUT /:id/columns/:subjectId/reorder ───────────────────────────────────────

export async function reorderColumns(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const { id: marksheetId, subjectId } = req.params as { id: string; subjectId: string };
    const teacherId = await getTeacherId(userId, institutionId);

    const marksheet = await prisma.marksheet.findFirst({
      where: { id: marksheetId, institutionId },
      select: { divisionId: true },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }

    const isClassTeacher = await isClassTeacherOf(teacherId, marksheet.divisionId, institutionId);
    if (!isClassTeacher) {
      await assertSubjectTeacher(teacherId, marksheet.divisionId, subjectId, institutionId);
    }

    const { orderedIds } = reorderColumnsSchema.parse(req.body);

    await prisma.$transaction(
      orderedIds.map((colId, idx) =>
        prisma.marksheetExamColumn.updateMany({
          where: { id: colId, marksheetId, subjectId, institutionId },
          data: { order: idx },
        })
      )
    );

    res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── PUT /:id/subjects/:subjectId/config ───────────────────────────────────────

export async function setSubjectConfig(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const { id: marksheetId, subjectId } = req.params as { id: string; subjectId: string };
    const teacherId = await getTeacherId(userId, institutionId);

    const marksheet = await prisma.marksheet.findFirst({
      where: { id: marksheetId, institutionId },
      select: { divisionId: true },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }

    await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);

    const { passingMarks, gradeScale } = subjectConfigSchema.parse(req.body);

    const config = await prisma.marksheetSubjectConfig.upsert({
      where: { marksheetId_subjectId: { marksheetId, subjectId } },
      create: { marksheetId, subjectId, institutionId, passingMarks, gradeScale },
      update: { passingMarks, gradeScale },
      select: { subjectId: true, passingMarks: true, gradeScale: true },
    });

    res.json({ success: true, data: config });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── PUT /:id/scores/subject/:subjectId ────────────────────────────────────────

export async function bulkUpsertScores(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const { id: marksheetId, subjectId } = req.params as { id: string; subjectId: string };
    const teacherId = await getTeacherId(userId, institutionId);

    const marksheet = await prisma.marksheet.findFirst({
      where: { id: marksheetId, institutionId },
      select: { divisionId: true },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }

    // Must be subject teacher for this subject
    await assertSubjectTeacher(teacherId, marksheet.divisionId, subjectId, institutionId);

    const { scores } = bulkScoresSchema.parse(req.body);

    // Validate all provided examColumnIds belong to this marksheet + subjectId
    const columnIds = [...new Set(scores.map((s) => s.examColumnId))];
    const validColumns = await prisma.marksheetExamColumn.findMany({
      where: { id: { in: columnIds }, marksheetId, subjectId, institutionId },
      select: { id: true },
    });
    const validColumnIdSet = new Set(validColumns.map((c) => c.id));
    const invalid = columnIds.find((id) => !validColumnIdSet.has(id));
    if (invalid) {
      res.status(400).json({ success: false, error: `Column ${invalid} does not belong to subject ${subjectId} in this marksheet` });
      return;
    }

    await prisma.$transaction(
      scores.map((sc) =>
        prisma.marksheetScore.upsert({
          where: { examColumnId_studentId: { examColumnId: sc.examColumnId, studentId: sc.studentId } },
          create: {
            marksheetId,
            examColumnId: sc.examColumnId,
            studentId: sc.studentId,
            institutionId,
            score: sc.score,
            isAbsent: sc.isAbsent,
            enteredByTeacherId: teacherId,
          },
          update: {
            score: sc.score,
            isAbsent: sc.isAbsent,
            enteredByTeacherId: teacherId,
          },
        })
      )
    );

    res.json({ success: true, data: { saved: scores.length } });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── POST /:id/graded-subjects ─────────────────────────────────────────────────

export async function addGradedSubject(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const marksheetId = req.params.id as string;
    const teacherId = await getTeacherId(userId, institutionId);

    const marksheet = await prisma.marksheet.findFirst({
      where: { id: marksheetId, institutionId },
      select: { divisionId: true },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }
    await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);

    const { name } = addGradedSubjectSchema.parse(req.body);
    const maxOrder = await prisma.marksheetGradedSubject.aggregate({
      where: { marksheetId },
      _max: { order: true },
    });
    const subject = await prisma.marksheetGradedSubject.create({
      data: { marksheetId, institutionId, name, order: (maxOrder._max.order ?? -1) + 1 },
      select: { id: true, name: true, order: true },
    });

    res.status(201).json({ success: true, data: subject });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── PATCH /:id/graded-subjects/:gsId ─────────────────────────────────────────

export async function editGradedSubject(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const { id: marksheetId, gsId } = req.params as { id: string; gsId: string };
    const teacherId = await getTeacherId(userId, institutionId);

    const gs = await prisma.marksheetGradedSubject.findFirst({
      where: { id: gsId, marksheetId, institutionId },
      select: { id: true, marksheet: { select: { divisionId: true } } },
    });
    if (!gs) { res.status(404).json({ success: false, error: "Graded subject not found" }); return; }
    await assertClassTeacher(teacherId, gs.marksheet.divisionId, institutionId);

    const { name } = editGradedSubjectSchema.parse(req.body);
    const updated = await prisma.marksheetGradedSubject.update({
      where: { id: gsId },
      data: { name },
      select: { id: true, name: true, order: true },
    });

    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── DELETE /:id/graded-subjects/:gsId ────────────────────────────────────────

export async function deleteGradedSubject(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const { id: marksheetId, gsId } = req.params as { id: string; gsId: string };
    const teacherId = await getTeacherId(userId, institutionId);

    const gs = await prisma.marksheetGradedSubject.findFirst({
      where: { id: gsId, marksheetId, institutionId },
      select: { id: true, marksheet: { select: { divisionId: true } } },
    });
    if (!gs) { res.status(404).json({ success: false, error: "Graded subject not found" }); return; }
    await assertClassTeacher(teacherId, gs.marksheet.divisionId, institutionId);

    // Cascade deletes graded scores via onDelete: Cascade on MarksheetGradedScore
    await prisma.marksheetGradedSubject.delete({ where: { id: gsId } });
    res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── PUT /:id/graded-subjects/reorder ─────────────────────────────────────────

export async function reorderGradedSubjects(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const marksheetId = req.params.id as string;
    const teacherId = await getTeacherId(userId, institutionId);

    const marksheet = await prisma.marksheet.findFirst({
      where: { id: marksheetId, institutionId },
      select: { divisionId: true },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }
    await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);

    const { orderedIds } = reorderGradedSubjectsSchema.parse(req.body);

    await prisma.$transaction(
      orderedIds.map((gsId, idx) =>
        prisma.marksheetGradedSubject.updateMany({
          where: { id: gsId, marksheetId, institutionId },
          data: { order: idx },
        })
      )
    );

    res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── PATCH /:id/graded-section-title ──────────────────────────────────────────

export async function updateGradedSectionTitle(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const marksheetId = req.params.id as string;
    const teacherId = await getTeacherId(userId, institutionId);

    const marksheet = await prisma.marksheet.findFirst({
      where: { id: marksheetId, institutionId },
      select: { divisionId: true },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }
    await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);

    const { title } = gradedSectionTitleSchema.parse(req.body);
    await prisma.marksheet.update({
      where: { id: marksheetId },
      data: { gradedSectionTitle: title },
    });

    res.json({ success: true, data: { gradedSectionTitle: title } });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── PUT /:id/graded-scores ────────────────────────────────────────────────────

export async function bulkUpsertGradedScores(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const marksheetId = req.params.id as string;
    const teacherId = await getTeacherId(userId, institutionId);

    const marksheet = await prisma.marksheet.findFirst({
      where: { id: marksheetId, institutionId },
      select: { divisionId: true },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }
    await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);

    const { scores } = bulkGradedScoresSchema.parse(req.body);

    await prisma.$transaction(
      scores.map((sc) =>
        prisma.marksheetGradedScore.upsert({
          where: { gradedSubjectId_studentId: { gradedSubjectId: sc.gradedSubjectId, studentId: sc.studentId } },
          create: {
            marksheetId,
            gradedSubjectId: sc.gradedSubjectId,
            studentId: sc.studentId,
            institutionId,
            term1Grade: sc.term1Grade ?? null,
            term2Grade: sc.term2Grade ?? null,
          },
          update: {
            ...(sc.term1Grade !== undefined && { term1Grade: sc.term1Grade }),
            ...(sc.term2Grade !== undefined && { term2Grade: sc.term2Grade }),
          },
        })
      )
    );

    res.json({ success: true, data: { saved: scores.length } });
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

    // App-wide convention: class teacher = DivisionAssignment with subjectId = null.
    const assignments = await prisma.divisionAssignment.findMany({
      where: { divisionId, teacherId, institutionId },
      select: { subjectId: true },
    });
    const isClassTeacher = assignments.some(a => a.subjectId === null);
    if (assignments.length === 0) {
      res.status(403).json({ success: false, error: "Not assigned to this division" });
      return;
    }
    const mySubjectIds = assignments.map(a => a.subjectId).filter((id): id is string => id !== null);

    const marksheet = await prisma.marksheet.findUnique({
      where: { divisionId_academicYear: { divisionId, academicYear } },
      select: { id: true },
    });
    if (!marksheet) {
      res.status(404).json({ success: false, error: "Marksheet not initialized for this division and academic year" });
      return;
    }

    const data = await fetchMarksheetFull(marksheet.id, institutionId, teacherId, isClassTeacher, mySubjectIds);
    res.json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}

// ── POST /:id/publish ─────────────────────────────────────────────────────────

export async function publishMarksheet(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const marksheetId = req.params.id as string;
    const teacherId = await getTeacherId(userId, institutionId);

    const marksheet = await prisma.marksheet.findFirst({
      where: { id: marksheetId, institutionId },
      include: {
        division: {
          include: { standard: true },
        },
      },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }
    await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);

    // Must have at least one exam column
    const columnCount = await prisma.marksheetExamColumn.count({ where: { marksheetId, institutionId } });
    if (columnCount === 0) {
      res.status(400).json({ success: false, error: "Add at least one exam column before publishing" });
      return;
    }

    // Fetch institution name
    const institution = await prisma.institution.findUnique({
      where: { id: institutionId },
      select: { name: true },
    });

    // Fetch all data needed for PDF
    const [subjects, examColumns, scores, gradedSubjects, gradedScores, students] = await Promise.all([
      prisma.subject.findMany({
        where: { standardId: marksheet.division.standardId, institutionId },
        orderBy: { order: "asc" },
        select: { id: true, name: true, code: true },
      }),
      prisma.marksheetExamColumn.findMany({
        where: { marksheetId, institutionId },
        orderBy: [{ subjectId: "asc" }, { order: "asc" }],
        select: { id: true, subjectId: true, name: true, maxMarks: true },
      }),
      prisma.marksheetScore.findMany({
        where: { marksheetId, institutionId },
        select: { examColumnId: true, studentId: true, score: true, isAbsent: true },
      }),
      prisma.marksheetGradedSubject.findMany({
        where: { marksheetId, institutionId },
        orderBy: { order: "asc" },
        select: { id: true, name: true },
      }),
      prisma.marksheetGradedScore.findMany({
        where: { marksheetId, institutionId },
        select: { gradedSubjectId: true, studentId: true, term1Grade: true, term2Grade: true },
      }),
      prisma.student.findMany({
        where: { divisionId: marksheet.divisionId, institutionId },
        include: { user: { select: { name: true } } },
        orderBy: [{ rollNo: "asc" }, { joinedAt: "asc" }],
      }),
    ]);

    // Build maps
    const columnsBySubject: Record<string, { id: string; name: string; maxMarks: number }[]> = {};
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

    const pdfBuffer = await generateMarksheetPdf({
      divisionName: marksheet.division.name,
      standardName: marksheet.division.standard.name,
      institutionName: institution?.name ?? "Institution",
      academicYear: marksheet.academicYear,
      subjects: subjects.map((s) => ({ id: s.id, name: s.name, code: s.code ?? s.name.slice(0, 4) })),
      examColumnsBySubject: columnsBySubject,
      students: students.map((s) => ({ id: s.id, name: s.user.name ?? "", rollNo: s.rollNo ?? "" })),
      scoreMap,
      gradedSubjects,
      gradedScoreMap,
      gradedSectionTitle: marksheet.gradedSectionTitle,
    });

    const r2Key = `institutions/${institutionId}/marksheets/${marksheetId}.pdf`;
    const r2Client = getR2Client();

    // Update DB first — if R2 upload fails, DB points at a missing-but-recoverable key
    // rather than leaving an orphaned live PDF in R2 with no DB record.
    await prisma.marksheet.update({
      where: { id: marksheetId },
      data: { status: "PUBLISHED", pdfR2Key: r2Key },
    });

    await r2Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      Body: pdfBuffer,
      ContentType: "application/pdf",
    }));

    // Queue old PDF for deletion if re-publishing with a different key
    if (marksheet.pdfR2Key && marksheet.pdfR2Key !== r2Key) {
      await prisma.pendingFileDeletion.create({
        data: {
          r2Key: marksheet.pdfR2Key,
          scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });
    }

    const publicUrl = `${process.env.R2_PUBLIC_URL!.replace(/\/$/, "")}/${r2Key}`;
    res.json({ success: true, data: { pdfUrl: publicUrl, shareToken: marksheet.shareToken } });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}
