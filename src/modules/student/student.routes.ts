import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { prisma } from "../../utils/prisma";
import { z } from "zod";
import multer from "multer";
import { listTests, startTest, submitTest, getAttempt, listAssignments, submitAssignment, getOwnSubmission, assignmentUpload } from "./tasks.controller";
import { uploadImageToSupabase, generateSignedAvatarUrl, generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { listStudentRemarks } from "../../services/remark.service";
import { resolveGrade, GradeScaleEntry } from "../../services/gradeScale";
// Notifications are institution-scoped (per NotificationRecipient.institutionId),
// so the same handlers serve every role within an institution.
import {
  listNotifications,
  markNotificationRead,
  dismissNotification,
  markAllNotificationsRead,
} from "../admin/notifications.controller";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const router = Router();

const S = [authMiddleware(["STUDENT"]), institutionAccessMiddleware];

// ── Notifications (institution-scoped) ────────────────────────────────────────
router.get("/notifications", ...S, listNotifications);
router.patch("/notifications/read-all", ...S, markAllNotificationsRead);
router.patch("/notifications/:recipientId/read", ...S, markNotificationRead);
router.patch("/notifications/:recipientId/dismiss", ...S, dismissNotification);

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

// ── GET /student/tasks/tests ──────────────────────────────────────────────────
router.get("/tasks/tests", ...S, listTests);

// ── POST /student/tasks/tests/:id/start ────────────────────────────────────────
router.post("/tasks/tests/:id/start", ...S, startTest);

// ── POST /student/tasks/tests/:id/submit ───────────────────────────────────────
router.post("/tasks/tests/:id/submit", ...S, submitTest);

// ── GET /student/tasks/attempts/:id ────────────────────────────────────────────
router.get("/tasks/attempts/:id", ...S, getAttempt);

// ── Assignment routes ──────────────────────────────────────────────────────────
router.get("/tasks/assignments", ...S, listAssignments);
router.post("/tasks/assignments/:id/submit", ...S, assignmentUpload.single("file"), submitAssignment);
router.get("/tasks/assignments/:id/submission", ...S, getOwnSubmission);

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

function gradeFor(pct: number | null, scale: GradeScaleEntry[]): string {
  if (pct === null) return "—";
  return resolveGrade(pct, scale);
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
      select: { id: true, status: true, gradedSectionTitle: true, academicYear: true, pdfR2Key: true, gradeScale: true },
    });
    console.log("[marksheet] divisionId:", student.division.id, "academicYear:", academicYear, "found:", marksheet?.academicYear, "status:", marksheet?.status);
    if (!marksheet || marksheet.status !== "PUBLISHED") {
      marksheet = await prisma.marksheet.findFirst({
        where: { divisionId: student.division.id, institutionId, status: "PUBLISHED" },
        orderBy: { academicYear: "desc" },
        select: { id: true, status: true, gradedSectionTitle: true, academicYear: true, pdfR2Key: true, gradeScale: true },
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
      return { id: sub.id, name: sub.name, code: sub.code ?? sub.name.slice(0, 4), color: sub.color ?? null, columns, total: { scored, max }, pct, grade: gradeFor(pct, (marksheet.gradeScale ?? []) as GradeScaleEntry[]) };
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
        gradeScale: (marksheet.gradeScale ?? []) as GradeScaleEntry[],
        gradedSectionTitle: marksheet.gradedSectionTitle,
        standardName: student.division.standard?.name ?? "",
        divisionName: student.division.name,
        student: { name: student.user.name, rollNo: student.rollNo ?? "" },
        subjects: subjectResults,
        grandTotal: { scored: grandScored, max: grandMax },
        grandPct,
        grade: gradeFor(grandPct, (marksheet.gradeScale ?? []) as GradeScaleEntry[]),
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

// ── GET /student/overview — home/overview page bundle ────────────────────────
router.get("/overview", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      include: {
        user: { select: { name: true } },
        division: { select: { id: true, name: true, standardId: true, standard: { select: { name: true } } } },
      },
    });
    if (!student) {
      res.status(404).json({ success: false, error: "Student not found" });
      return;
    }

    const divisionId = student.divisionId;

    // ── Attendance summary ────────────────────────────────────────────────────
    const now = new Date();
    const curMonth = now.getMonth();
    const curYear = now.getFullYear();
    const startYear = curMonth >= 5 ? curYear : curYear - 1;
    const startDate = `${startYear}-06-01`;
    const endDate = `${startYear + 1}-05-31`;

    const attendanceRecords = await prisma.attendance.findMany({
      where: { studentId: student.id, institutionId, date: { gte: startDate, lte: endDate } },
      select: { status: true },
    });
    const totalAttendance = attendanceRecords.length;
    const presentCount = attendanceRecords.filter(r => r.status === "P" || r.status === "L").length;
    const attendancePct = totalAttendance > 0 ? Math.round((presentCount / totalAttendance) * 100) : null;

    // ── Marks + leaderboard (only if marksheet published) ────────────────────
    let marksPct: number | null = null;
    let classRank: number | null = null;
    let totalStudents = 0;
    let leaderboard: { rank: number; name: string; rollNo: string; pct: number; isMe: boolean }[] = [];

    if (divisionId) {
      const marksheet = await prisma.marksheet.findFirst({
        where: { divisionId, institutionId, status: "PUBLISHED" },
        orderBy: { academicYear: "desc" },
        select: { id: true },
      });

      if (marksheet) {
        const [allScores, allStudents] = await Promise.all([
          prisma.marksheetScore.findMany({
            where: { marksheetId: marksheet.id, institutionId },
            select: { studentId: true, score: true, isAbsent: true },
          }),
          prisma.student.findMany({
            where: { divisionId, institutionId, status: "ACTIVE" },
            select: { id: true, rollNo: true, user: { select: { name: true } } },
          }),
        ]);

        const [allCols] = await Promise.all([
          prisma.marksheetExamColumn.findMany({
            where: { marksheetId: marksheet.id, institutionId },
            select: { id: true, maxMarks: true },
          }),
        ]);
        const grandMax = allCols.reduce((sum, c) => sum + c.maxMarks, 0);

        // total scored per student
        const totals = new Map<string, number>();
        for (const sc of allScores) {
          if (!sc.isAbsent && sc.score !== null) {
            totals.set(sc.studentId, (totals.get(sc.studentId) ?? 0) + sc.score);
          }
        }

        totalStudents = allStudents.length;
        const myTotal = totals.get(student.id) ?? 0;
        marksPct = grandMax > 0 ? Math.round((myTotal / grandMax) * 100) : null;
        classRank = [...totals.values()].filter(t => t > myTotal).length + 1;

        // Build leaderboard: sort all students by score desc, take top 5
        const ranked = allStudents
          .map(s => ({
            id: s.id,
            name: s.user.name ?? "Unknown",
            rollNo: s.rollNo ?? "",
            total: totals.get(s.id) ?? 0,
            pct: grandMax > 0 ? Math.round(((totals.get(s.id) ?? 0) / grandMax) * 100) : 0,
          }))
          .sort((a, b) => b.total - a.total);

        leaderboard = ranked.slice(0, 5).map((s, i) => ({
          rank: i + 1,
          name: s.name,
          rollNo: s.rollNo,
          pct: s.pct,
          isMe: s.id === student.id,
        }));
      }
    }

    // ── Pending tasks (active assignments for this division) ──────────────────
    const pendingTasks = divisionId
      ? await prisma.taskAssignment.count({
          where: { divisionId, institutionId, status: "ACTIVE" },
        })
      : 0;

    // ── Next upcoming event (test/exam/submission/etc.) ───────────────────────
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const nextEventRow = divisionId
      ? await prisma.calendarEvent.findFirst({
          where: {
            institutionId,
            date: { gte: todayStart },
            OR: [{ divisionId: null }, { divisionId }],
          },
          orderBy: { date: "asc" },
          select: { type: true, label: true, date: true },
        })
      : await prisma.calendarEvent.findFirst({
          where: { institutionId, date: { gte: todayStart }, divisionId: null },
          orderBy: { date: "asc" },
          select: { type: true, label: true, date: true },
        });

    let nextEvent: { type: string; label: string; date: string; daysAway: number } | null = null;
    if (nextEventRow) {
      const diffMs = nextEventRow.date.getTime() - todayStart.getTime();
      const daysAway = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      nextEvent = { type: nextEventRow.type.toLowerCase(), label: nextEventRow.label, date: nextEventRow.date.toISOString(), daysAway };
    }

    // ── Latest announcement (most recent general or class post) ───────────────
    const latestPost = await prisma.campusFeedPost.findFirst({
      where: divisionId
        ? { institutionId, OR: [{ divisionId: null }, { divisionId }] }
        : { institutionId, divisionId: null },
      orderBy: { createdAt: "desc" },
      select: { title: true, type: true },
    });

    res.json({
      success: true,
      data: {
        student: {
          name: student.user.name ?? "",
          rollNo: student.rollNo ?? "",
          divisionName: student.division?.name ?? "",
          standardName: student.division?.standard?.name ?? "",
        },
        attendance: { pct: attendancePct, present: presentCount, total: totalAttendance },
        marks: { pct: marksPct, classRank, totalStudents },
        pendingTasks,
        nextEvent,
        latestPost: latestPost ? { title: latestPost.title, type: latestPost.type.toLowerCase() } : null,
        leaderboard,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /student/remarks — Flags & Warnings (Report Cards) ───────────────────
router.get("/remarks", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!student) {
      res.status(404).json({ success: false, error: "Student not found" });
      return;
    }

    const remarks = await listStudentRemarks(student.id, institutionId!);
    res.json({ success: true, data: remarks });
  } catch (err) {
    next(err);
  }
});

// ── GET /student/class — division info, classmates, my subject scores ────────
router.get("/class", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      include: {
        division: {
          include: {
            standard: { select: { id: true, name: true } },
            assignments: {
              include: {
                teacher: { include: { user: { select: { name: true } } } },
                subject: { select: { id: true, name: true, code: true, color: true, order: true } },
              },
            },
            classTeacher: { include: { user: { select: { name: true } } } },
            _count: { select: { students: true } },
          },
        },
      },
    });
    if (!student || !student.division) {
      res.json({ success: true, data: { division: null, classmates: [], myScores: [] } });
      return;
    }

    const division = student.division;
    const divisionId = division.id;
    const standardId = division.standard.id;

    // ── Academic year (June–May) ─────────────────────────────────────────────
    const now = new Date();
    const curMonth = now.getMonth();
    const curYear = now.getFullYear();
    const startYear = curMonth >= 5 ? curYear : curYear - 1;
    const academicYear = `${startYear}-${String(startYear + 1).slice(2)}`;
    const ayStart = `${startYear}-06-01`;
    const ayEnd = `${startYear + 1}-05-31`;

    // ── Subjects list from division assignments ──────────────────────────────
    const subjectListRaw = division.assignments
      .filter(a => a.subjectId != null && a.subject != null)
      .sort((a, b) => (a.subject!.order ?? 0) - (b.subject!.order ?? 0))
      .map(a => ({
        id: a.subject!.id,
        name: a.subject!.name,
        code: a.subject!.code,
        color: a.subject!.color ?? "#7C3AED",
        teacherName: a.teacher.user.name,
        teacherAvatarUrlRaw: (a.teacher as { avatarUrl?: string | null }).avatarUrl ?? null,
      }));

    // ── Classmates with attendance % and marks % ─────────────────────────────
    const [allStudents, attendanceRecords] = await Promise.all([
      prisma.student.findMany({
        where: { divisionId, institutionId },
        include: { user: { select: { id: true, name: true } } },
        orderBy: [{ rollNo: "asc" }],
      }),
      prisma.attendance.findMany({
        where: { divisionId, institutionId, date: { gte: ayStart, lte: ayEnd } },
        select: { studentId: true, status: true },
      }),
    ]);

    // Batch-sign all avatar URLs (students + teachers) in one round-trip
    const rawAvatarUrls: (string | null | undefined)[] = [
      ...allStudents.map(s => (s as { avatarUrl?: string | null }).avatarUrl),
      ...subjectListRaw.map(s => s.teacherAvatarUrlRaw),
    ];
    const signedAvatarMap = await generateSignedAvatarUrlsBatch(rawAvatarUrls);
    const resolveAvatar = (url: string | null | undefined) =>
      url ? (signedAvatarMap[url] ?? url) : null;

    // Finalise subject list with signed teacher avatar URLs
    const subjectList = subjectListRaw.map(s => ({
      id: s.id,
      name: s.name,
      code: s.code,
      color: s.color,
      teacherName: s.teacherName,
      teacherAvatarUrl: resolveAvatar(s.teacherAvatarUrlRaw),
    }));

    // Build studentId → signed avatar map for classmates + leaderboard
    const studentAvatarMap = new Map<string, string | null>();
    for (const s of allStudents) {
      studentAvatarMap.set(s.id, resolveAvatar((s as { avatarUrl?: string | null }).avatarUrl));
    }

    // Attendance % per student
    const attMap = new Map<string, { p: number; total: number }>();
    for (const r of attendanceRecords) {
      const cur = attMap.get(r.studentId) ?? { p: 0, total: 0 };
      cur.total++;
      if (r.status === "P" || r.status === "L") cur.p++;
      attMap.set(r.studentId, cur);
    }

    // Fetch campus feed posts (RESULT + MATERIAL) for this division
    const [feedPosts, allMarksheets] = await Promise.all([
      prisma.campusFeedPost.findMany({
        where: { divisionId, institutionId, type: { in: ["RESULT", "MATERIAL"] } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, type: true, title: true, subject: true,
          attachmentUrl: true, attachmentType: true, attachmentName: true, createdAt: true,
          author: { select: { name: true } },
        },
      }),
      // Fetch all published marksheets for scoring/leaderboard only
      prisma.marksheet.findMany({
        where: { divisionId, institutionId, status: "PUBLISHED" },
        orderBy: { academicYear: "desc" },
        select: { id: true },
      }),
    ]);

    // Separate into results and materials
    const resultFiles = feedPosts
      .filter(p => p.type === "RESULT")
      .map(p => ({
        id: p.id,
        title: p.title,
        attachmentUrl: p.attachmentUrl,
        attachmentType: p.attachmentType,
        attachmentName: p.attachmentName,
        postedBy: p.author.name ?? "—",
        createdAt: p.createdAt.toISOString(),
      }));

    // Materials grouped by subject name (case-insensitive)
    const materialsRaw = feedPosts.filter(p => p.type === "MATERIAL");
    const subjectMaterialsMap = new Map<string, typeof materialsRaw>();
    for (const m of materialsRaw) {
      const key = (m.subject ?? "").toLowerCase().trim();
      const arr = subjectMaterialsMap.get(key) ?? [];
      arr.push(m);
      subjectMaterialsMap.set(key, arr);
    }

    // Use the most recent published marksheet for leaderboard/scoring
    const marksheet = allMarksheets[0] ?? null;

    const marksMap = new Map<string, number>(); // studentId → total combined scored
    const offlineMarksMap = new Map<string, number>(); // studentId → offline scored
    const onlineMarksMap = new Map<string, number>(); // studentId → online scored
    let grandMax = 0;
    let offlineGrandMax = 0;
    let onlineGrandMax = 0;
    let allColumns: { id: string; subjectId: string; name: string; maxMarks: number }[] = [];
    let allScoreRows: { studentId: string; examColumnId: string; score: number | null; isAbsent: boolean }[] = [];
    let mySubjectScores: { subjectId: string; subjectName: string; subjectCode: string; subjectColor: string; columns: { name: string; scored: number | null; max: number; isAbsent: boolean }[]; totalScored: number; totalMax: number; pct: number | null }[] = [];

    if (marksheet) {

      const [columns, allScores, myScoresRaw] = await Promise.all([
        prisma.marksheetExamColumn.findMany({
          where: { marksheetId: marksheet.id, institutionId },
          orderBy: [{ subjectId: "asc" }, { order: "asc" }],
          select: { id: true, subjectId: true, name: true, maxMarks: true },
        }),
        prisma.marksheetScore.findMany({
          where: { marksheetId: marksheet.id, institutionId },
          select: { studentId: true, examColumnId: true, score: true, isAbsent: true },
        }),
        prisma.marksheetScore.findMany({
          where: { marksheetId: marksheet.id, institutionId, studentId: student.id },
          select: { examColumnId: true, score: true, isAbsent: true },
        }),
      ]);

      allColumns = columns;
      allScoreRows = allScores;

      // Distinguish online vs offline by column name
      const isOnlineCol = (name: string) => name.toLowerCase().includes("online");

      // Grand max totals
      for (const c of columns) {
        grandMax += c.maxMarks;
        if (isOnlineCol(c.name)) onlineGrandMax += c.maxMarks;
        else offlineGrandMax += c.maxMarks;
      }

      // Build colId → isOnline map
      const colOnlineMap = new Map(columns.map(c => [c.id, isOnlineCol(c.name)]));

      // Per-student totals (combined, offline, online)
      for (const sc of allScores) {
        if (!sc.isAbsent && sc.score !== null) {
          marksMap.set(sc.studentId, (marksMap.get(sc.studentId) ?? 0) + sc.score);
          if (colOnlineMap.get(sc.examColumnId)) {
            onlineMarksMap.set(sc.studentId, (onlineMarksMap.get(sc.studentId) ?? 0) + sc.score);
          } else {
            offlineMarksMap.set(sc.studentId, (offlineMarksMap.get(sc.studentId) ?? 0) + sc.score);
          }
        }
      }

      // My subject-wise scores
      const myScoreByCol = new Map(myScoresRaw.map(s => [s.examColumnId, s]));
      const colsBySubject = new Map<string, typeof columns>();
      for (const c of columns) {
        const arr = colsBySubject.get(c.subjectId) ?? [];
        arr.push(c);
        colsBySubject.set(c.subjectId, arr);
      }

      for (const subj of subjectList) {
        const cols = colsBySubject.get(subj.id) ?? [];
        if (cols.length === 0) continue;
        const subCols = cols.map(c => {
          const s = myScoreByCol.get(c.id);
          return { name: c.name, scored: s?.score ?? null, max: c.maxMarks, isAbsent: s?.isAbsent ?? false };
        });
        const totalMax = cols.reduce((s, c) => s + c.maxMarks, 0);
        const totalScored = subCols.reduce((s, c) => s + (c.isAbsent ? 0 : (c.scored ?? 0)), 0);
        const pct = totalMax > 0 ? Math.round((totalScored / totalMax) * 100) : null;
        mySubjectScores.push({ subjectId: subj.id, subjectName: subj.name, subjectCode: subj.code ?? "", subjectColor: subj.color, columns: subCols, totalScored, totalMax, pct });
      }
    }

    // Build ranked classmates (sorted by combined score)
    const sorted = [...allStudents].sort((a, b) => (marksMap.get(b.id) ?? -1) - (marksMap.get(a.id) ?? -1));
    const classmates = sorted.map((s, i) => {
      const att = attMap.get(s.id);
      const attPct = att && att.total > 0 ? Math.round((att.p / att.total) * 100) : null;
      const scored = marksMap.get(s.id) ?? null;
      const marksPct = scored !== null && grandMax > 0 ? Math.round((scored / grandMax) * 100) : null;
      const offlineScored = offlineMarksMap.get(s.id) ?? null;
      const offlinePct = offlineScored !== null && offlineGrandMax > 0 ? Math.round((offlineScored / offlineGrandMax) * 100) : null;
      const onlineScored = onlineMarksMap.get(s.id) ?? null;
      const onlinePct = onlineScored !== null && onlineGrandMax > 0 ? Math.round((onlineScored / onlineGrandMax) * 100) : null;
      return {
        id: s.id,
        name: s.user.name,
        rollNo: s.rollNo ?? "—",
        rank: marksheet ? i + 1 : null,
        attendancePct: attPct,
        marksPct,
        offlinePct,
        onlinePct,
        isMe: s.id === student.id,
        avatarUrl: studentAvatarMap.get(s.id) ?? null,
      };
    });

    // ── Per-subject leaderboards (top 5, with combined/offline/online) ────────
    type LbEntry = { name: string; avatarUrl: string | null; combinedPct: number; offlinePct: number | null; onlinePct: number | null; isMe: boolean };
    const subjectLeaderboards: Record<string, LbEntry[]> = {};
    if (marksheet && allColumns.length > 0) {
      const isOnlineCol = (name: string) => name.toLowerCase().includes("online");
      const colSubjectMap = new Map(allColumns.map(c => [c.id, c.subjectId]));
      const colOnlineMap = new Map(allColumns.map(c => [c.id, isOnlineCol(c.name)]));

      const subjectCombinedMaxMap = new Map<string, number>();
      const subjectOfflineMaxMap = new Map<string, number>();
      const subjectOnlineMaxMap = new Map<string, number>();
      for (const c of allColumns) {
        subjectCombinedMaxMap.set(c.subjectId, (subjectCombinedMaxMap.get(c.subjectId) ?? 0) + c.maxMarks);
        if (colOnlineMap.get(c.id)) subjectOnlineMaxMap.set(c.subjectId, (subjectOnlineMaxMap.get(c.subjectId) ?? 0) + c.maxMarks);
        else subjectOfflineMaxMap.set(c.subjectId, (subjectOfflineMaxMap.get(c.subjectId) ?? 0) + c.maxMarks);
      }

      const subjectStudentCombined = new Map<string, Map<string, number>>();
      const subjectStudentOffline = new Map<string, Map<string, number>>();
      const subjectStudentOnline = new Map<string, Map<string, number>>();

      for (const sc of allScoreRows) {
        if (!sc.isAbsent && sc.score !== null) {
          const subjectId = colSubjectMap.get(sc.examColumnId);
          if (!subjectId) continue;
          const isOnline = colOnlineMap.get(sc.examColumnId) ?? false;

          const cMap = subjectStudentCombined.get(subjectId) ?? new Map<string, number>();
          cMap.set(sc.studentId, (cMap.get(sc.studentId) ?? 0) + sc.score);
          subjectStudentCombined.set(subjectId, cMap);

          if (isOnline) {
            const oMap = subjectStudentOnline.get(subjectId) ?? new Map<string, number>();
            oMap.set(sc.studentId, (oMap.get(sc.studentId) ?? 0) + sc.score);
            subjectStudentOnline.set(subjectId, oMap);
          } else {
            const fMap = subjectStudentOffline.get(subjectId) ?? new Map<string, number>();
            fMap.set(sc.studentId, (fMap.get(sc.studentId) ?? 0) + sc.score);
            subjectStudentOffline.set(subjectId, fMap);
          }
        }
      }

      const studentNameMap = new Map<string, string>();
      for (const s of allStudents) studentNameMap.set(s.id, s.user.name ?? "—");

      for (const subj of subjectList) {
        const cMap = subjectStudentCombined.get(subj.id);
        const combinedMax = subjectCombinedMaxMap.get(subj.id) ?? 0;
        if (!cMap || combinedMax === 0) { subjectLeaderboards[subj.id] = []; continue; }
        subjectLeaderboards[subj.id] = [...cMap.entries()]
          .map(([sid, total]): LbEntry => {
            const offMax = subjectOfflineMaxMap.get(subj.id) ?? 0;
            const onMax = subjectOnlineMaxMap.get(subj.id) ?? 0;
            const offScored = subjectStudentOffline.get(subj.id)?.get(sid) ?? null;
            const onScored = subjectStudentOnline.get(subj.id)?.get(sid) ?? null;
            return {
              name: studentNameMap.get(sid) ?? "—",
              avatarUrl: studentAvatarMap.get(sid) ?? null,
              combinedPct: Math.round((total / combinedMax) * 100),
              offlinePct: offScored !== null && offMax > 0 ? Math.round((offScored / offMax) * 100) : null,
              onlinePct: onScored !== null && onMax > 0 ? Math.round((onScored / onMax) * 100) : null,
              isMe: sid === student.id,
            };
          })
          .sort((a, b) => b.combinedPct - a.combinedPct)
          .slice(0, 5);
      }
    }

    // Build per-subject materials (match by subject name, case-insensitive)
    type MaterialEntry = { id: string; title: string; attachmentUrl: string | null; attachmentType: string | null; attachmentName: string | null; postedBy: string; createdAt: string };
    const subjectMaterials: Record<string, MaterialEntry[]> = {};
    for (const subj of subjectList) {
      const key = subj.name.toLowerCase().trim();
      const posts = subjectMaterialsMap.get(key) ?? [];
      subjectMaterials[subj.id] = posts.map(p => ({
        id: p.id, title: p.title,
        attachmentUrl: p.attachmentUrl,
        attachmentType: p.attachmentType,
        attachmentName: p.attachmentName,
        postedBy: p.author.name ?? "—",
        createdAt: p.createdAt.toISOString(),
      }));
    }

    res.json({
      success: true,
      data: {
        division: {
          id: division.id,
          name: division.name,
          standardName: division.standard.name,
          classTeacherName: division.classTeacher?.user.name ?? null,
          totalStudents: division._count.students,
          subjects: subjectList,
        },
        resultFiles,
        subjectMaterials,
        classmates,
        myScores: mySubjectScores,
        subjectLeaderboards,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /student/feed/debug — temp: verify student division & class post counts ─
router.get("/feed/debug", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      select: { id: true, divisionId: true, division: { select: { id: true, name: true } } },
    });

    const generalPostCount = await prisma.campusFeedPost.count({
      where: { institutionId, divisionId: null },
    });

    const classPostCount = student?.divisionId
      ? await prisma.campusFeedPost.count({ where: { institutionId, divisionId: student.divisionId } })
      : 0;

    const allClassPostCount = await prisma.campusFeedPost.count({
      where: { institutionId, NOT: { divisionId: null } },
    });

    res.json({
      success: true,
      data: {
        userId,
        institutionId,
        studentRecord: student ?? null,
        divisionId: student?.divisionId ?? null,
        divisionName: student?.division?.name ?? null,
        generalPostCount,
        classPostCountForThisDivision: classPostCount,
        totalClassPostsInInstitution: allClassPostCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /student/feed/posts — merged general + class feed ─────────────────────
router.get("/feed/posts", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      select: { divisionId: true },
    });

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const typeFilter = req.query.type as string | undefined;
    const typeCondition =
      typeFilter && typeFilter !== "all"
        ? { type: typeFilter.toUpperCase() as "ANNOUNCEMENT" | "NOTICE" | "MATERIAL" | "RESULT" }
        : {};

    const divisionId = student?.divisionId ?? null;

    console.log(`[student/feed/posts] userId=${userId} institutionId=${institutionId} divisionId=${divisionId}`);

    // Always return general posts; add class posts if student is assigned to a division
    const where = divisionId
      ? { institutionId, OR: [{ divisionId: null as string | null }, { divisionId }], ...typeCondition }
      : { institutionId, divisionId: null as string | null, ...typeCondition };

    const [posts, total] = await prisma.$transaction([
      prisma.campusFeedPost.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { author: { select: { id: true, name: true, role: true, teacher: { select: { avatarUrl: true } } } } },
      }),
      prisma.campusFeedPost.count({ where }),
    ]);

    console.log(`[student/feed/posts] total=${total} class_posts=${posts.filter(p => p.divisionId).length} general_posts=${posts.filter(p => !p.divisionId).length}`);

    const rawFeedAvatars = posts.map(p => (p.author as { teacher?: { avatarUrl?: string | null } | null }).teacher?.avatarUrl ?? null);
    const feedAvatarMap = await generateSignedAvatarUrlsBatch(rawFeedAvatars);
    const resolveFeedAvatar = (url: string | null | undefined) => url ? (feedAvatarMap[url] ?? url) : null;

    res.json({
      success: true,
      data: posts.map(p => ({
        id: p.id,
        type: p.type.toLowerCase(),
        source: p.divisionId ? "class" : "general",
        title: p.title,
        body: p.body,
        subject: p.subject,
        attachmentUrl: p.attachmentUrl,
        attachmentType: p.attachmentType,
        attachmentName: p.attachmentName,
        createdAt: p.createdAt.toISOString(),
        author: {
          id: p.author.id,
          name: p.author.name ?? "Unknown",
          role: p.author.role,
          avatarUrl: resolveFeedAvatar((p.author as { teacher?: { avatarUrl?: string | null } | null }).teacher?.avatarUrl),
        },
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /student/feed/events — merged general + class calendar ────────────────
router.get("/feed/events", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      select: { divisionId: true },
    });

    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const month = parseInt(req.query.month as string);
    const validMonth = Number.isNaN(month) ? new Date().getMonth() : month;

    const start = new Date(year, validMonth, 1);
    const end = new Date(year, validMonth + 1, 0, 23, 59, 59, 999);

    const divisionId = student?.divisionId ?? null;

    console.log(`[student/feed/events] userId=${userId} institutionId=${institutionId} divisionId=${divisionId} year=${year} month=${validMonth}`);

    // Always return general events; add class events if student is assigned to a division
    const where = divisionId
      ? { institutionId, date: { gte: start, lte: end }, OR: [{ divisionId: null }, { divisionId }] }
      : { institutionId, date: { gte: start, lte: end }, divisionId: null };

    const events = await prisma.calendarEvent.findMany({
      where,
      orderBy: { date: "asc" },
      include: { createdBy: { select: { id: true, name: true } } },
    });

    res.json({
      success: true,
      data: events.map(e => ({
        id: e.id,
        type: e.type.toLowerCase(),
        label: e.label,
        date: e.date.getUTCDate(),
        fullDate: e.date.toISOString(),
        isClassEvent: !!e.divisionId,
        createdBy: e.createdBy ? { id: e.createdBy.id, name: e.createdBy.name } : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
