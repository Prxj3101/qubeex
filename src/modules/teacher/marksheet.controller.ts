import { Response, NextFunction } from "express";
import crypto from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { logAudit } from "../../services/audit.service";
import { resolveGrade, GradeScaleEntry } from "../../services/gradeScale";
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
  updateMarksheetGradeScaleSchema,
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
  gradeScale: GradeScaleEntry[];
}): Promise<Buffer> {
  // ── Layout constants ──────────────────────────────────────────────────────
  const M       = 28;   // page margin
  const ROLL_W  = 36;
  const NAME_W  = 125;
  const GRP_H   = 14;   // header row-1: subject group label
  const COL_H   = 26;   // header row-2: exam column label
  const ROW_H   = 14;   // data row height

  // ── Colours ───────────────────────────────────────────────────────────────
  const C_HDR_GRP  = "#D6C9B4";
  const C_HDR_COL  = "#EDE4D6";
  const C_OVRL_GRP = "#C8B8D8";
  const C_GRD_GRP  = "#C0C8E8";
  const C_SUMM     = "#F0E8D8";
  const C_EVEN     = "#FAF5EE";
  const C_ODD      = "#F3EBE0";
  const C_TEXT     = "#1A100A";
  const C_MUTED    = "#666666";
  const C_BORDER   = "#C4AC88";

  // ── Column definitions ────────────────────────────────────────────────────
  type ColKind = "exam" | "subTotal" | "subPct" | "gradedT1" | "gradedT2" | "grandTotal" | "grandPct" | "grade";
  interface ColDef { kind: ColKind; group: string; colId?: string; subjectId?: string; gsId?: string; maxMarks?: number; examName?: string; }

  const cols: ColDef[] = [];
  params.subjects.forEach((sub) => {
    (params.examColumnsBySubject[sub.id] ?? []).forEach((ec) =>
      cols.push({ kind: "exam", group: sub.name, subjectId: sub.id, colId: ec.id, examName: ec.name, maxMarks: ec.maxMarks })
    );
    cols.push({ kind: "subTotal", group: sub.name, subjectId: sub.id });
    cols.push({ kind: "subPct",   group: sub.name, subjectId: sub.id });
  });
  params.gradedSubjects.forEach((gs) => {
    cols.push({ kind: "gradedT1", group: params.gradedSectionTitle, gsId: gs.id });
    cols.push({ kind: "gradedT2", group: params.gradedSectionTitle, gsId: gs.id });
  });
  cols.push({ kind: "grandTotal", group: "Overall" });
  cols.push({ kind: "grandPct",   group: "Overall" });
  cols.push({ kind: "grade",      group: "Overall" });

  // ── Column width: fill usable space, clamp 26–52 ─────────────────────────
  const doc = new PDFDocument({ margin: M, size: "A4", layout: "landscape", autoFirstPage: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const PW = doc.page.width;
    const PH = doc.page.height;
    const UW = PW - M * 2;
    const availForCols = UW - ROLL_W - NAME_W;
    const COL_W = cols.length > 0
      ? Math.max(26, Math.min(52, Math.floor(availForCols / cols.length)))
      : 40;
    const TW = ROLL_W + NAME_W + cols.length * COL_W; // total table width

    // ── Helpers ──────────────────────────────────────────────────────────────
    /** Render text into a cell with NO line-break so doc.y never drifts. */
    const ct = (
      text: string,
      x: number, y: number, w: number, h: number,
      opts: { bold?: boolean; align?: "left" | "center" | "right"; size?: number; color?: string } = {}
    ) => {
      const { bold = false, align = "center", size = 6.5, color = C_TEXT } = opts;
      const vPad = Math.max(2, Math.floor((h - size * 1.15) / 2));
      doc.fontSize(size)
        .font(bold ? "Helvetica-Bold" : "Helvetica")
        .fillColor(color)
        .text(text, x + 2, y + vPad, { width: w - 4, align, lineBreak: false, ellipsis: true });
    };

    /** Draw a horizontal rule. */
    const hline = (x: number, y: number, w: number, color = C_BORDER, lw = 0.3) =>
      doc.lineWidth(lw).moveTo(x, y).lineTo(x + w, y).stroke(color);

    /** Draw a vertical rule. */
    const vline = (x: number, y1: number, y2: number, color = C_BORDER, lw = 0.3) =>
      doc.lineWidth(lw).moveTo(x, y1).lineTo(x, y2).stroke(color);

    // ── Two-row table header ─────────────────────────────────────────────────
    const drawHeader = (startY: number): number => {
      const y1 = startY;
      const y2 = y1 + GRP_H;
      const hTot = GRP_H + COL_H;

      // Roll + Name: tall cells spanning both header rows
      doc.rect(M,           y1, ROLL_W, hTot).fill(C_HDR_GRP);
      doc.rect(M + ROLL_W,  y1, NAME_W, hTot).fill(C_HDR_GRP);
      ct("Roll",         M,          y1, ROLL_W, hTot, { bold: true, size: 7 });
      ct("Student Name", M + ROLL_W, y1, NAME_W, hTot, { bold: true, align: "left", size: 7 });

      // Row-1: group spans
      let gx = M + ROLL_W + NAME_W;
      let gi = 0;
      while (gi < cols.length) {
        const grp = cols[gi].group;
        let span = 0;
        while (gi + span < cols.length && cols[gi + span].group === grp) span++;
        const gw = span * COL_W;
        const bg = grp === "Overall" ? C_OVRL_GRP : grp === params.gradedSectionTitle ? C_GRD_GRP : C_HDR_GRP;
        doc.rect(gx, y1, gw, GRP_H).fill(bg);
        ct(grp, gx, y1, gw, GRP_H, { bold: true, size: 6 });
        gx += gw; gi += span;
      }

      // Row-2: individual column labels
      cols.forEach((col, i) => {
        const cx = M + ROLL_W + NAME_W + i * COL_W;
        const isSummary = col.kind === "subTotal" || col.kind === "subPct" ||
                          col.kind === "grandTotal" || col.kind === "grandPct" || col.kind === "grade";
        doc.rect(cx, y2, COL_W, COL_H).fill(isSummary ? C_HDR_GRP : C_HDR_COL);

        const lines: string[] =
          col.kind === "exam"       ? [col.examName!, `/${col.maxMarks}`]
          : col.kind === "subTotal" ? ["Total"]
          : col.kind === "subPct"   ? ["%"]
          : col.kind === "gradedT1" ? ["Term 1"]
          : col.kind === "gradedT2" ? ["Term 2"]
          : col.kind === "grandTotal" ? ["Grand", "Total"]
          : col.kind === "grandPct"   ? ["Grand", "%"]
          :                            ["Grade"];

        const lineH = COL_H / (lines.length > 1 ? lines.length + 0.4 : 1);
        lines.forEach((ln, li) =>
          doc.fontSize(5.5).font("Helvetica-Bold").fillColor(C_TEXT)
            .text(ln, cx + 2, y2 + 3 + li * lineH, { width: COL_W - 4, align: "center", lineBreak: false, ellipsis: true })
        );
      });

      // Grid lines over header
      doc.lineWidth(0.5).rect(M, y1, TW, hTot).stroke(C_BORDER);
      hline(M + ROLL_W + NAME_W, y2, cols.length * COL_W, C_BORDER, 0.4);
      vline(M + ROLL_W, y1, y1 + hTot, C_BORDER, 0.4);
      vline(M + ROLL_W + NAME_W, y1, y1 + hTot, C_BORDER, 0.4);
      for (let i = 1; i < cols.length; i++)
        vline(M + ROLL_W + NAME_W + i * COL_W, y1, y1 + hTot, C_BORDER, 0.25);

      return y2 + COL_H;
    };

    // ── Title block ──────────────────────────────────────────────────────────
    doc.fontSize(13).font("Helvetica-Bold").fillColor(C_TEXT)
      .text(params.institutionName, M, M, { width: UW, align: "center", lineBreak: false });
    doc.fontSize(8).font("Helvetica").fillColor(C_MUTED)
      .text(
        `${params.standardName} – ${params.divisionName}   ·   Academic Year: ${params.academicYear}`,
        M, M + 17, { width: UW, align: "center", lineBreak: false }
      );

    let y = M + 36;
    let tableTopY = y;
    y = drawHeader(y);

    // ── Data rows ────────────────────────────────────────────────────────────
    params.students.forEach((student, si) => {
      if (y + ROW_H > PH - M) {
        // Close table border on this page
        doc.lineWidth(0.5).rect(M, tableTopY, TW, y - tableTopY).stroke(C_BORDER);
        doc.addPage({ size: "A4", layout: "landscape", margin: M });
        y = M; tableTopY = M;
        y = drawHeader(y);
      }

      // Row background
      doc.rect(M, y, TW, ROW_H).fill(si % 2 === 0 ? C_EVEN : C_ODD);

      // Roll + Name
      ct(student.rollNo || "—", M,          y, ROLL_W, ROW_H, { align: "center" });
      ct(student.name   || "—", M + ROLL_W, y, NAME_W, ROW_H, { align: "left" });
      vline(M + ROLL_W,         y, y + ROW_H, C_BORDER, 0.3);
      vline(M + ROLL_W + NAME_W, y, y + ROW_H, C_BORDER, 0.3);

      // Per-subject totals (computed once per row)
      const subTotals: Record<string, { scored: number; max: number }> = {};
      params.subjects.forEach((sub) => {
        let scored = 0, max = 0;
        (params.examColumnsBySubject[sub.id] ?? []).forEach((ec) => {
          const e = params.scoreMap[ec.id]?.[student.id];
          if (e?.score !== null && e?.score !== undefined) { scored += e.score!; max += ec.maxMarks; }
          else if (!e?.isAbsent) { max += ec.maxMarks; }
        });
        subTotals[sub.id] = { scored, max };
      });
      const grandScored = Object.values(subTotals).reduce((s, v) => s + v.scored, 0);
      const grandMax    = Object.values(subTotals).reduce((s, v) => s + v.max,    0);

      // Draw data cells
      cols.forEach((col, i) => {
        const cx = M + ROLL_W + NAME_W + i * COL_W;

        let text = "—", bold = false;
        const isSummary = col.kind === "subTotal" || col.kind === "subPct" ||
                          col.kind === "grandTotal" || col.kind === "grandPct" || col.kind === "grade";
        if (isSummary) doc.rect(cx, y, COL_W, ROW_H).fill(C_SUMM);

        if (col.kind === "exam") {
          const e = params.scoreMap[col.colId!]?.[student.id];
          text = e?.isAbsent ? "AB" : (e?.score !== null && e?.score !== undefined) ? String(e.score) : "—";
        } else if (col.kind === "subTotal") {
          const { scored, max } = subTotals[col.subjectId!];
          text = `${scored}/${max}`; bold = true;
        } else if (col.kind === "subPct") {
          const { scored, max } = subTotals[col.subjectId!];
          text = max > 0 ? `${Math.round((scored / max) * 100)}%` : "—";
        } else if (col.kind === "gradedT1") {
          text = params.gradedScoreMap[col.gsId!]?.[student.id]?.term1Grade ?? "—";
        } else if (col.kind === "gradedT2") {
          text = params.gradedScoreMap[col.gsId!]?.[student.id]?.term2Grade ?? "—";
        } else if (col.kind === "grandTotal") {
          text = `${grandScored}/${grandMax}`; bold = true;
        } else if (col.kind === "grandPct") {
          const pct = grandMax > 0 ? Math.round((grandScored / grandMax) * 100) : null;
          text = pct !== null ? `${pct}%` : "—"; bold = true;
        } else if (col.kind === "grade") {
          const pct = grandMax > 0 ? Math.round((grandScored / grandMax) * 100) : null;
          text = pct !== null ? resolveGrade(pct, params.gradeScale) : "—"; bold = true;
        }

        ct(text, cx, y, COL_W, ROW_H, { bold, align: "center" });
        vline(cx + COL_W, y, y + ROW_H, C_BORDER, 0.25);
      });

      hline(M, y + ROW_H, TW, C_BORDER, 0.25);
      y += ROW_H;
    });

    // Outer border
    doc.lineWidth(0.5).rect(M, tableTopY, TW, y - tableTopY).stroke(C_BORDER);
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
          gradeScale: true,
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
    gradeScale: (marksheet.gradeScale ?? []) as { grade: string; minPct: number }[],
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
    // Structure (exam columns) is owned by the class teacher only.
    // Subject teachers fill marks, they do not create/modify columns.
    await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);

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

    // Structure is class-teacher-only.
    await assertClassTeacher(teacherId, column.marksheet.divisionId, institutionId);

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

    // Structure is class-teacher-only.
    await assertClassTeacher(teacherId, column.marksheet.divisionId, institutionId);

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

    // Structure is class-teacher-only.
    await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);

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

// ── PATCH /:id/grade-scale ────────────────────────────────────────────────────

export async function updateMarksheetGradeScale(
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

    const { gradeScale } = updateMarksheetGradeScaleSchema.parse(req.body);
    const sorted = [...gradeScale].sort((a, b) => b.minPct - a.minPct);

    await prisma.marksheet.update({
      where: { id: marksheetId },
      data: { gradeScale: sorted },
    });

    res.json({ success: true, data: { gradeScale: sorted } });
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
      select: { divisionId: true, gradeScale: true },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }
    await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);

    const { scores } = bulkGradedScoresSchema.parse(req.body);

    // Validate each grade against the marksheet's own configured grade scale
    // (falls back to a default set only if the class teacher hasn't configured one).
    const configuredScale = (marksheet.gradeScale ?? []) as { grade: string; minPct: number }[];
    const validGrades = new Set(
      configuredScale.length > 0
        ? configuredScale.map((g) => g.grade)
        : ["A+", "A", "B", "C", "D", "F"]
    );
    for (const sc of scores) {
      if (sc.term1Grade != null && !validGrades.has(sc.term1Grade)) {
        res.status(400).json({ success: false, error: `"${sc.term1Grade}" is not in the configured grade scale` });
        return;
      }
      if (sc.term2Grade != null && !validGrades.has(sc.term2Grade)) {
        res.status(400).json({ success: false, error: `"${sc.term2Grade}" is not in the configured grade scale` });
        return;
      }
    }

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

// ── Shared PDF data builder ─────────────────────────────────────────────────────

type MarksheetPdfParams = Parameters<typeof generateMarksheetPdf>[0];

async function buildMarksheetPdfData(
  marksheetId: string,
  institutionId: string
): Promise<{ params: MarksheetPdfParams; columnCount: number }> {
  const marksheet = await prisma.marksheet.findFirst({
    where: { id: marksheetId, institutionId },
    include: { division: { include: { standard: true } } },
  });
  if (!marksheet) throw { status: 404, message: "Marksheet not found" };

  const institution = await prisma.institution.findUnique({
    where: { id: institutionId },
    select: { name: true },
  });

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

  return {
    columnCount: examColumns.length,
    params: {
      divisionName: marksheet.division.name,
      standardName: marksheet.division.standard.name,
      institutionName: institution?.name ?? "Institution",
      academicYear: marksheet.academicYear,
      subjects: subjects
        .filter((s) => (columnsBySubject[s.id]?.length ?? 0) > 0)
        .map((s) => ({ id: s.id, name: s.name, code: s.code ?? s.name.slice(0, 4) })),
      examColumnsBySubject: columnsBySubject,
      students: students.map((s) => ({ id: s.id, name: s.user.name ?? "", rollNo: s.rollNo ?? "" })),
      scoreMap,
      gradedSubjects,
      gradedScoreMap,
      gradedSectionTitle: marksheet.gradedSectionTitle,
      gradeScale: (marksheet.gradeScale ?? []) as GradeScaleEntry[],
    },
  };
}

/** Narrow PDF params to a single subject (used for subject-teacher downloads). */
function filterPdfParamsToSubject(params: MarksheetPdfParams, subjectId: string): MarksheetPdfParams {
  return {
    ...params,
    subjects: params.subjects.filter((s) => s.id === subjectId),
    examColumnsBySubject: { [subjectId]: params.examColumnsBySubject[subjectId] ?? [] },
    gradedSubjects: [],
    gradedScoreMap: {},
  };
}

/** Full sheet reorganized exam-by-exam: one section per distinct exam-column name. */
async function generateExamWisePdf(params: MarksheetPdfParams): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(14).font("Helvetica-Bold").fillColor("#2A1F10")
      .text(`${params.institutionName} — Marksheet (Exam-wise)`, { align: "center" });
    doc.fontSize(10).font("Helvetica").fillColor("#555")
      .text(`${params.standardName} - ${params.divisionName} | Academic Year: ${params.academicYear}`, { align: "center" });
    doc.moveDown(0.6);

    // Distinct exam-column names, in first-seen order across subjects.
    const examNames: string[] = [];
    for (const sub of params.subjects) {
      for (const col of params.examColumnsBySubject[sub.id] ?? []) {
        if (!examNames.includes(col.name)) examNames.push(col.name);
      }
    }

    const COL_W = 60, NAME_W = 120, ROLL_W = 40;
    const startX = doc.page.margins.left;

    if (examNames.length === 0) {
      doc.fontSize(10).fillColor("#999").text("No exam columns yet.", { align: "center" });
      doc.end();
      return;
    }

    examNames.forEach((examName, idx) => {
      const cols: { name: string; col: { id: string; name: string; maxMarks: number } }[] = [];
      for (const sub of params.subjects) {
        const col = (params.examColumnsBySubject[sub.id] ?? []).find((c) => c.name === examName);
        if (col) cols.push({ name: sub.name, col });
      }
      if (cols.length === 0) return;

      if (idx > 0) doc.moveDown(0.8);
      let y = doc.y;
      if (y > doc.page.height - doc.page.margins.bottom - 70) {
        doc.addPage({ layout: "landscape", size: "A4", margin: 30 });
        y = doc.page.margins.top;
      }
      doc.fontSize(11).font("Helvetica-Bold").fillColor("#2A1F10").text(examName, startX, y);
      y = doc.y + 4;

      const headerCols = [...cols.map((c) => `${c.name}\n/${c.col.maxMarks}`), "Total", "%"];
      const totalWidth = ROLL_W + NAME_W + headerCols.length * COL_W;

      doc.rect(startX, y, totalWidth, 28).fill("#E8DDD0");
      doc.fillColor("#2A1F10").font("Helvetica-Bold").fontSize(7);
      doc.text("Roll", startX + 2, y + 4, { width: ROLL_W - 4 });
      doc.text("Student Name", startX + ROLL_W + 2, y + 4, { width: NAME_W - 4 });
      headerCols.forEach((label, i) => doc.text(label, startX + ROLL_W + NAME_W + i * COL_W + 2, y + 4, { width: COL_W - 4 }));
      y += 28;

      doc.font("Helvetica").fontSize(7);
      params.students.forEach((student, si) => {
        if (y > doc.page.height - doc.page.margins.bottom - 20) {
          doc.addPage({ layout: "landscape", size: "A4", margin: 30 });
          y = doc.page.margins.top;
        }
        doc.rect(startX, y, totalWidth, 16).fill(si % 2 === 0 ? "#FAF5EE" : "#F5EFE5");
        doc.fillColor("#2A1F10");
        doc.text(student.rollNo, startX + 2, y + 3, { width: ROLL_W - 4 });
        doc.text(student.name, startX + ROLL_W + 2, y + 3, { width: NAME_W - 4, ellipsis: true });
        let scored = 0, max = 0;
        cols.forEach((c, ci) => {
          const entry = params.scoreMap[c.col.id]?.[student.id];
          const sc = entry?.score ?? null;
          const absent = entry?.isAbsent ?? false;
          doc.text(absent ? "AB" : sc !== null ? String(sc) : "—", startX + ROLL_W + NAME_W + ci * COL_W + 2, y + 3, { width: COL_W - 4 });
          if (sc !== null) { scored += sc; max += c.col.maxMarks; }
          else if (!absent) { max += c.col.maxMarks; }
        });
        const pct = max > 0 ? Math.round((scored / max) * 100) : null;
        doc.text(`${scored}/${max}`, startX + ROLL_W + NAME_W + cols.length * COL_W + 2, y + 3, { width: COL_W - 4 });
        doc.text(pct !== null ? `${pct}%` : "—", startX + ROLL_W + NAME_W + (cols.length + 1) * COL_W + 2, y + 3, { width: COL_W - 4 });
        y += 16;
      });
      doc.y = y;
    });

    doc.end();
  });
}

// ── GET /:id/download?scope=full|subject&subjectId= ──────────────────────────────

export async function downloadMarksheet(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const marksheetId = req.params.id as string;
    const scope = (req.query.scope as string) || "full";
    const subjectIdParam = req.query.subjectId as string | undefined;
    const teacherId = await getTeacherId(userId, institutionId);

    const marksheet = await prisma.marksheet.findFirst({
      where: { id: marksheetId, institutionId },
      select: { divisionId: true },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }

    const { params } = await buildMarksheetPdfData(marksheetId, institutionId);

    let pdfBuffer: Buffer;
    let filename: string;
    const baseName = `${params.standardName}-${params.divisionName}`.replace(/[^\w-]+/g, "_");

    if (scope === "subject") {
      if (!subjectIdParam) { res.status(400).json({ success: false, error: "subjectId required for subject scope" }); return; }
      // Subject teacher of this subject, or the class teacher, may download it.
      const classTeacher = await prisma.divisionAssignment.findFirst({
        where: { divisionId: marksheet.divisionId, teacherId, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!classTeacher) {
        await assertSubjectTeacher(teacherId, marksheet.divisionId, subjectIdParam, institutionId);
      }
      const subjectName = params.subjects.find((s) => s.id === subjectIdParam)?.name ?? "subject";
      pdfBuffer = await generateMarksheetPdf(filterPdfParamsToSubject(params, subjectIdParam));
      filename = `${baseName}-${subjectName.replace(/[^\w-]+/g, "_")}.pdf`;
    } else if (scope === "exam") {
      // Exam-wise sheet — class teacher only.
      await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);
      pdfBuffer = await generateExamWisePdf(params);
      filename = `${baseName}-exam-wise.pdf`;
    } else {
      // Full sheet — class teacher only.
      await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);
      pdfBuffer = await generateMarksheetPdf(params);
      filename = `${baseName}-marksheet.pdf`;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
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
      select: { divisionId: true, pdfR2Key: true, shareToken: true },
    });
    if (!marksheet) { res.status(404).json({ success: false, error: "Marksheet not found" }); return; }
    await assertClassTeacher(teacherId, marksheet.divisionId, institutionId);

    const columnCount = await prisma.marksheetExamColumn.count({
      where: { marksheetId, institutionId },
    });
    if (columnCount === 0) {
      res.status(400).json({ success: false, error: "Add at least one exam column before publishing" });
      return;
    }

    await prisma.marksheet.update({
      where: { id: marksheetId },
      data: { status: "PUBLISHED" },
    });

    const pubDivision = await prisma.division.findFirst({
      where: { id: marksheet.divisionId, institutionId },
      select: { name: true, standard: { select: { name: true } } },
    });
    logAudit("RESULT_UPLOADED", {
      userId,
      actorRole: "TEACHER",
      institutionId,
      details: `Published marksheet results for ${pubDivision ? `${pubDivision.standard.name} - ${pubDivision.name}` : marksheet.divisionId}`,
    });

    res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
}
