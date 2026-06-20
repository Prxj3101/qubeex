import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { prisma } from "../../utils/prisma";
import { z } from "zod";

const router = Router();

const S = [authMiddleware(["STUDENT"]), institutionAccessMiddleware];

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  dob: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  phone: z.string().max(20).trim().optional().nullable(),
  religion: z.string().trim().optional().nullable(),
  category: z.string().trim().optional().nullable(),
  bloodGroup: z.string().trim().optional().nullable(),
  aadharNo: z.string().trim().optional().nullable(),
  panNo: z.string().trim().optional().nullable(),
  emergencyContact: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  state: z.string().trim().optional().nullable(),
  pincode: z.string().trim().optional().nullable(),
  country: z.string().trim().optional().nullable(),
  guardians: z
    .array(z.object({ name: z.string(), number: z.string(), relation: z.string() }))
    .optional()
    .nullable(),
});

// ── GET /student/me ───────────────────────────────────────────────────────────
router.get("/me", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      include: {
        user: {
          select: { id: true, name: true, email: true, mustChangePassword: true },
        },
        standard: { select: { id: true, name: true } },
        division: { select: { id: true, name: true } },
      },
    });

    if (!student) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }

    res.json({ success: true, data: student });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /student/profile ────────────────────────────────────────────────────
// Students can edit personal info but NOT academic details (rollNo, houseColor, standardId, divisionId, studentId, status)
router.patch("/profile", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });

    if (!student) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }

    const data = updateProfileSchema.parse(req.body);
    const { name, guardians, ...studentFields } = data;

    await prisma.$transaction(async (tx) => {
      if (name) {
        await tx.user.update({ where: { id: userId }, data: { name } });
      }
      await tx.student.update({
        where: { id: student.id },
        data: {
          ...studentFields,
          ...(guardians !== undefined
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? { guardians: guardians === null ? null : (guardians as any) }
            : {}),
        },
      });
    });

    const updated = await prisma.student.findFirst({
      where: { id: student.id },
      include: {
        user: {
          select: { id: true, name: true, email: true, mustChangePassword: true },
        },
        standard: { select: { id: true, name: true } },
        division: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// ── GET /student/marksheet?academicYear= ──────────────────────────────────────
// Returns the logged-in student's own results, but ONLY if the class marksheet
// has been PUBLISHED. Draft marksheets are never visible to students.
function getCurrentAcademicYear(): string {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const startYear = month >= 5 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}

function gradeFor(pct: number | null): string {
  if (pct === null) return "—";
  if (pct >= 75) return "A";
  if (pct >= 60) return "B";
  if (pct >= 45) return "C";
  if (pct >= 35) return "D";
  return "F";
}

router.get("/marksheet", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    const academicYear = (req.query.academicYear as string) || getCurrentAcademicYear();

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      include: {
        user: { select: { name: true } },
        division: { select: { id: true, name: true, standardId: true, standard: { select: { name: true } } } },
      },
    });
    if (!student || !student.division) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }

    const marksheet = await prisma.marksheet.findUnique({
      where: { divisionId_academicYear: { divisionId: student.division.id, academicYear } },
      select: { id: true, status: true, gradedSectionTitle: true, academicYear: true, pdfR2Key: true },
    });
    if (!marksheet || marksheet.status !== "PUBLISHED") {
      res.status(404).json({ success: false, error: "Results not published yet" });
      return;
    }

    const [subjects, examColumns, scores, gradedSubjects, gradedScores] = await Promise.all([
      prisma.subject.findMany({
        where: { standardId: student.division.standardId, institutionId },
        orderBy: { order: "asc" },
        select: { id: true, name: true, code: true },
      }),
      prisma.marksheetExamColumn.findMany({
        where: { marksheetId: marksheet.id, institutionId },
        orderBy: [{ subjectId: "asc" }, { order: "asc" }],
        select: { id: true, subjectId: true, name: true, maxMarks: true },
      }),
      prisma.marksheetScore.findMany({
        where: { marksheetId: marksheet.id, institutionId, studentId: student.id },
        select: { examColumnId: true, score: true, isAbsent: true },
      }),
      prisma.marksheetGradedSubject.findMany({
        where: { marksheetId: marksheet.id, institutionId },
        orderBy: { order: "asc" },
        select: { id: true, name: true },
      }),
      prisma.marksheetGradedScore.findMany({
        where: { marksheetId: marksheet.id, institutionId, studentId: student.id },
        select: { gradedSubjectId: true, term1Grade: true, term2Grade: true },
      }),
    ]);

    const scoreByCol = new Map(scores.map((s) => [s.examColumnId, s]));
    const colsBySubject: Record<string, typeof examColumns> = {};
    for (const c of examColumns) (colsBySubject[c.subjectId] ??= []).push(c);

    let grandScored = 0;
    let grandMax = 0;
    const subjectResults = subjects.map((sub) => {
      const cols = colsBySubject[sub.id] ?? [];
      let scored = 0;
      let max = 0;
      const columns = cols.map((c) => {
        const e = scoreByCol.get(c.id);
        const sc = e?.score ?? null;
        const absent = e?.isAbsent ?? false;
        if (sc !== null) { scored += sc; max += c.maxMarks; }
        else if (!absent) { max += c.maxMarks; }
        return { id: c.id, name: c.name, maxMarks: c.maxMarks, score: sc, isAbsent: absent };
      });
      grandScored += scored;
      grandMax += max;
      const pct = max > 0 ? Math.round((scored / max) * 100) : null;
      return { id: sub.id, name: sub.name, code: sub.code ?? sub.name.slice(0, 4), columns, total: { scored, max }, pct, grade: gradeFor(pct) };
    });
    const grandPct = grandMax > 0 ? Math.round((grandScored / grandMax) * 100) : null;

    const gradeByGs = new Map(gradedScores.map((g) => [g.gradedSubjectId, g]));
    const gradedResults = gradedSubjects.map((gs) => {
      const g = gradeByGs.get(gs.id);
      return { id: gs.id, name: gs.name, term1Grade: g?.term1Grade ?? null, term2Grade: g?.term2Grade ?? null };
    });

    const pdfUrl = marksheet.pdfR2Key
      ? `${process.env.R2_PUBLIC_URL!.replace(/\/$/, "")}/${marksheet.pdfR2Key}`
      : null;

    res.json({
      success: true,
      data: {
        academicYear: marksheet.academicYear,
        gradedSectionTitle: marksheet.gradedSectionTitle,
        standardName: student.division.standard?.name ?? "",
        divisionName: student.division.name,
        student: { name: student.user.name, rollNo: student.rollNo ?? "" },
        subjects: subjectResults,
        grandTotal: { scored: grandScored, max: grandMax },
        grandPct,
        grade: gradeFor(grandPct),
        gradedSubjects: gradedResults,
        pdfUrl,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
