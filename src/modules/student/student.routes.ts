import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { prisma } from "../../utils/prisma";
import { z } from "zod";
import multer from "multer";
import { uploadImageToSupabase, generateSignedAvatarUrl } from "../../services/storage.service";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const router = Router();

const S = [authMiddleware(["STUDENT"]), institutionAccessMiddleware];

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  dob: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  phone: z.string().max(20).trim().optional().nullable(),
  religion: z.string().trim().optional().nullable(),
  category: z.string().trim().optional().nullable(),
  nationality: z.string().trim().optional().nullable(),
  admissionYear: z.string().trim().optional().nullable(),
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
        institution: { select: { name: true } },
      },
    });

    if (!student) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }

    // Resolve avatar to a signed URL so it works on both public and private buckets
    let avatarUrl: string | null = student.avatarUrl;
    if (avatarUrl) {
      const signed = await generateSignedAvatarUrl(avatarUrl);
      if (signed) avatarUrl = signed;
    }

    res.json({ success: true, data: { ...student, avatarUrl } });
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

// ── POST /student/photo ───────────────────────────────────────────────────────
router.post("/photo", ...S, upload.single("photo"), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!req.file) {
      res.status(400).json({ success: false, error: "No photo file provided" });
      return;
    }

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!student) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }

    const { publicUrl } = await uploadImageToSupabase(req.file.buffer, {
      contentType: req.file.mimetype,
      folder: "student-photos",
      ownerId: student.id,
    });

    await prisma.student.update({
      where: { id: student.id },
      data: { avatarUrl: publicUrl },
    });

    // Return a signed URL so the client can display it immediately (works on private buckets too)
    const signedUrl = (await generateSignedAvatarUrl(publicUrl)) ?? publicUrl;
    res.json({ success: true, data: { avatarUrl: signedUrl } });
  } catch (err) {
    next(err);
  }
});

// ── GET /student/attendance ───────────────────────────────────────────────────
router.get("/attendance", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      select: { id: true, rollNo: true, user: { select: { name: true } } },
    });
    if (!student) {
      res.status(404).json({ success: false, error: "Student not found" });
      return;
    }

    // Determine academic year (June–May)
    const now = new Date();
    const curMonth = now.getMonth(); // 0-indexed
    const curYear = now.getFullYear();
    const startYear = curMonth >= 5 ? curYear : curYear - 1;
    const academicYear = `${startYear}-${String(startYear + 1).slice(2)}`;
    const startDate = `${startYear}-06-01`;
    const endDate = `${startYear + 1}-05-31`;

    const [records, holidays] = await Promise.all([
      prisma.attendance.findMany({
        where: { studentId: student.id, institutionId, date: { gte: startDate, lte: endDate } },
        select: { date: true, status: true },
      }),
      prisma.schoolHoliday.findMany({
        where: { institutionId, date: { gte: startDate, lte: endDate } },
        select: { date: true, name: true },
      }),
    ]);

    // daily map: "YYYY-MM-DD" → "P"|"A"|"L"
    const daily: Record<string, string> = {};
    for (const r of records) daily[r.date] = r.status;

    const ACADEMIC_MONTHS = [
      { month: "Jun", key: 5, year: startYear },
      { month: "Jul", key: 6, year: startYear },
      { month: "Aug", key: 7, year: startYear },
      { month: "Sep", key: 8, year: startYear },
      { month: "Oct", key: 9, year: startYear },
      { month: "Nov", key: 10, year: startYear },
      { month: "Dec", key: 11, year: startYear },
      { month: "Jan", key: 0, year: startYear + 1 },
      { month: "Feb", key: 1, year: startYear + 1 },
      { month: "Mar", key: 2, year: startYear + 1 },
      { month: "Apr", key: 3, year: startYear + 1 },
      { month: "May", key: 4, year: startYear + 1 },
    ];

    let totalPresent = 0, totalAbsent = 0, totalLeave = 0, totalRecords = 0;

    const monthly = ACADEMIC_MONTHS.map(({ month, key, year: mYear }) => {
      const paddedMonth = String(key + 1).padStart(2, "0");
      const prefix = `${mYear}-${paddedMonth}`;
      const mRecords = records.filter(r => r.date.startsWith(prefix));
      const p = mRecords.filter(r => r.status === "P").length;
      const a = mRecords.filter(r => r.status === "A").length;
      const l = mRecords.filter(r => r.status === "L").length;
      const total = p + a + l;
      const pct = total > 0 ? Math.round(((p + l) / total) * 100) : null;
      totalPresent += p; totalAbsent += a; totalLeave += l; totalRecords += total;
      return { month, key, year: mYear, present: p, absent: a, leave: l, total, pct };
    });

    const overallPct = totalRecords > 0
      ? Math.round(((totalPresent + totalLeave) / totalRecords) * 100)
      : null;

    res.json({
      success: true,
      data: {
        academicYear,
        startYear,
        overall: { present: totalPresent, absent: totalAbsent, leave: totalLeave, total: totalRecords, pct: overallPct },
        monthly,
        daily,
        holidays,
        student: { name: student.user.name, rollNo: student.rollNo ?? "" },
      },
    });
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

    // Try the requested (or computed current) academic year first; if not found or
    // not published, fall back to the most recent published marksheet for this
    // division. This handles the common case where results from the just-finished
    // year (e.g. 2025-26) are viewed in June of the new year (2026-27).
    let marksheet = await prisma.marksheet.findUnique({
      where: { divisionId_academicYear: { divisionId: student.division.id, academicYear } },
      select: { id: true, status: true, gradedSectionTitle: true, academicYear: true, pdfR2Key: true },
    });
    console.log("[marksheet] divisionId:", student.division.id, "academicYear:", academicYear, "found:", marksheet?.academicYear, "status:", marksheet?.status);
    if (!marksheet || marksheet.status !== "PUBLISHED") {
      marksheet = await prisma.marksheet.findFirst({
        where: { divisionId: student.division.id, institutionId, status: "PUBLISHED" },
        orderBy: { academicYear: "desc" },
        select: { id: true, status: true, gradedSectionTitle: true, academicYear: true, pdfR2Key: true },
      });
      console.log("[marksheet] fallback:", marksheet?.academicYear, "status:", marksheet?.status);
    }
    if (!marksheet) {
      res.status(404).json({ success: false, error: "Results not published yet" });
      return;
    }

    const [subjects, examColumns, scores, gradedSubjects, gradedScores] = await Promise.all([
      prisma.subject.findMany({
        where: { standardId: student.division.standardId, institutionId },
        orderBy: { order: "asc" },
        select: { id: true, name: true, code: true, color: true },
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
      return { id: sub.id, name: sub.name, code: sub.code ?? sub.name.slice(0, 4), color: sub.color ?? null, columns, total: { scored, max }, pct, grade: gradeFor(pct) };
    });
    const grandPct = grandMax > 0 ? Math.round((grandScored / grandMax) * 100) : null;

    // Compute class rank by comparing this student's total against all others
    const [allMarksheetScores, classSize] = await Promise.all([
      prisma.marksheetScore.findMany({
        where: { marksheetId: marksheet.id, institutionId },
        select: { studentId: true, score: true, isAbsent: true },
      }),
      prisma.student.count({
        where: { divisionId: student.division.id, institutionId, status: "ACTIVE" },
      }),
    ]);
    const studentTotals = new Map<string, number>();
    for (const sc of allMarksheetScores) {
      if (!sc.isAbsent && sc.score !== null) {
        studentTotals.set(sc.studentId, (studentTotals.get(sc.studentId) ?? 0) + sc.score);
      }
    }
    const studentsAboveMe = [...studentTotals.values()].filter((t) => t > grandScored).length;
    const classRank = studentsAboveMe + 1;

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
        classRank,
        classSize,
        gradedSubjects: gradedResults,
        pdfUrl,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
