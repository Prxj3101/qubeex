import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { resolveUsers } from "../../services/userLookup.service";
import { z } from "zod";
import multer from "multer";
import { listTests, startTest, heartbeatAttempt, submitTest, getAttempt, downloadAttemptPdf, listAssignments, submitAssignment, getOwnSubmission, assignmentUpload, getAssignmentPaper, downloadAssignmentPaperPdf } from "./tasks.controller";
import { uploadImageToR2, generateSignedAvatarUrl, generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { listStudentRemarks } from "../../services/remark.service";
import { studentMoney, getReceipt } from "../fees/fees.service";
import { listPTMNotes, acknowledgePTMNote } from "../../services/ptmNote.service";
import { translateBatch, DynamicTranslateLang } from "../../services/translation.service";
import { delCache } from "../../utils/cache";
import { resolveRequestedAcademicYear } from "../../utils/academicYear";
import { resolveGrade, GradeScaleEntry } from "../../services/gradeScale";
import { computeOnlineMarksheet } from "../../services/onlineMarksheet.service";
import { resolveAuthorDisplay, formatDisplayName } from "../../utils/authorDisplay";
import { buildStudentPIIUpdate, decryptStudentPII } from "../../services/fieldEncryption.service";
// Notifications are institution-scoped (per NotificationRecipient.institutionId),
// so the same handlers serve every role within an institution.
import {
  listNotifications,
  markNotificationRead,
  dismissNotification,
  markAllNotificationsRead,
} from "../admin/notifications.controller";
import { registerDevicePushToken, unregisterDevicePushToken } from "../admin/pushToken.controller";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const router = Router();

const S = [authMiddleware(["STUDENT"]), institutionAccessMiddleware, academicRoutingMiddleware];

// ── Notifications (institution-scoped) ────────────────────────────────────────
router.get("/notifications", ...S, listNotifications);
router.patch("/notifications/read-all", ...S, markAllNotificationsRead);
router.patch("/notifications/:recipientId/read", ...S, markNotificationRead);
router.patch("/notifications/:recipientId/dismiss", ...S, dismissNotification);
router.post("/push-token", ...S, registerDevicePushToken);
router.delete("/push-token", ...S, unregisterDevicePushToken);

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  // Students without a real email have it shown as blank in the UI (the
  // synthetic login placeholder is hidden from them) — editing any OTHER
  // field (e.g. just Contact No) still resends that blank string. An empty
  // string is handled in the route itself (not here) because whether it
  // means "leave unchanged" or "actually clear it" depends on what the
  // student's current email is.
  email: z.union([z.string().email().toLowerCase().trim(), z.literal("")]).optional(),
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

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      include: {
        standard: { select: { id: true, name: true } },
        division: { select: { id: true, name: true } },
      },
    });

    if (!student) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }

    const [userMap, institution] = await Promise.all([
      resolveUsers([student.userId], { id: true, name: true, email: true, mustChangePassword: true }),
      prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true, logoUrl: true } }),
    ]);

    // Resolve avatar to a signed URL so it works on both public and private buckets
    let avatarUrl: string | null = student.avatarUrl;
    if (avatarUrl) {
      const signed = await generateSignedAvatarUrl(avatarUrl);
      if (signed) avatarUrl = signed;
    }

    // A student account's User.email is auto-filled with a
    // "@students.qubeex.local" placeholder at creation time (since it can't
    // be null) unless a real email was actually entered — never show that
    // placeholder back to the student as if it were their own email.
    const user = userMap.get(student.userId) ?? null;
    const userForResponse = user && user.email?.endsWith("@students.qubeex.local")
      ? { ...user, email: null }
      : user;

    res.json({
      success: true,
      data: {
        ...student,
        ...decryptStudentPII(student),
        user: userForResponse,
        institution,
        avatarUrl,
      },
    });
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

// ── POST /student/tasks/tests/attempts/:id/heartbeat ───────────────────────────
// Keeps this device's single-device lock on an in-progress attempt alive
// while its test page is open (see startTest's device-lock logic).
router.post("/tasks/tests/attempts/:id/heartbeat", ...S, heartbeatAttempt);

// ── GET /student/tasks/attempts/:id ────────────────────────────────────────────
router.get("/tasks/attempts/:id", ...S, getAttempt);

// ── GET /student/tasks/attempts/:id/pdf — download own result as PDF ──────────
router.get("/tasks/attempts/:id/pdf", ...S, downloadAttemptPdf);

// ── Assignment routes ──────────────────────────────────────────────────────────
router.get("/tasks/assignments", ...S, listAssignments);
// multer runs before academicRoutingMiddleware (not via `...S`): busboy's internal
// stream events aren't reliably tracked as children of the AsyncLocalStorage scope
// academicRoutingMiddleware opens, so parsing the file first avoids the handler
// seeing "No academic client in context".
router.post("/tasks/assignments/:id/submit", authMiddleware(["STUDENT"]), institutionAccessMiddleware, assignmentUpload.single("file"), academicRoutingMiddleware, submitAssignment);
router.get("/tasks/assignments/:id/submission", ...S, getOwnSubmission);
router.get("/tasks/assignments/:id/paper", ...S, getAssignmentPaper);
router.get("/tasks/assignments/:id/paper/pdf", ...S, downloadAssignmentPaperPdf);

// ── PATCH /student/profile ────────────────────────────────────────────────────
// Students can edit personal info but NOT academic details (rollNo, houseColor, standardId, divisionId, studentId, status)
router.patch("/profile", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      select: { id: true, studentId: true },
    });

    if (!student) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }

    const data = updateProfileSchema.parse(req.body);
    const { name, email, guardians, aadharNo, phone, address, city, pincode, panNo, emergencyContact, ...studentFields } = data;
    // Encrypted at rest — phone, address, city, pincode, aadharNo, panNo,
    // emergencyContact, and guardians[].number never get stored in plaintext.
    const piiUpdate = buildStudentPIIUpdate({ phone, address, city, pincode, aadharNo, panNo, emergencyContact, guardians });

    const userChanges: { name?: string; email?: string } = {};
    if (name) userChanges.name = name;
    if (email !== undefined) {
      if (email === "") {
        // Empty string is ambiguous: it's either "this field was already
        // blank and just got resent" (student never had a real email) or
        // "the student just deleted their real email on purpose". Only the
        // second case needs a write — regenerate the same kind of synthetic
        // placeholder used at account creation, since User.email can't be
        // null/empty. If it was already a placeholder, there's nothing to do.
        const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
        const alreadyPlaceholder = currentUser?.email.endsWith("@students.qubeex.local") ?? true;
        if (!alreadyPlaceholder) {
          userChanges.email = `${student.studentId.toLowerCase().replace(/-/g, "")}@students.qubeex.local`;
        }
      } else {
        const conflict = await prisma.user.findFirst({ where: { email, NOT: { id: userId } } });
        if (conflict) {
          throw new Error("EMAIL_TAKEN");
        }
        userChanges.email = email;
      }
    }
    const studentUpdate = {
      where: { id: student.id },
      data: {
        ...studentFields,
        ...piiUpdate,
      },
    };

    // User (central) and Student (may be tenant, for BYOD) can live in two
    // different databases, so a single transaction can't span both. Managed
    // institutions run both writes atomically (academicDb() === prisma); BYOD
    // runs them sequentially — see docs/superpowers/specs/2026-08-11-byod-cross-db-joins.md.
    const acad = academicDb();
    if (acad === prisma) {
      await prisma.$transaction([
        ...(Object.keys(userChanges).length > 0 ? [prisma.user.update({ where: { id: userId }, data: userChanges })] : []),
        acad.student.update(studentUpdate),
      ]);
    } else {
      if (Object.keys(userChanges).length > 0) {
        await prisma.user.update({ where: { id: userId }, data: userChanges });
      }
      await acad.student.update(studentUpdate);
    }

    const updatedStudent = await academicDb().student.findFirst({
      where: { id: student.id },
      include: {
        standard: { select: { id: true, name: true } },
        division: { select: { id: true, name: true } },
      },
    });
    const updatedUserMap = await resolveUsers([userId], { id: true, name: true, email: true, mustChangePassword: true });

    res.json({
      success: true,
      data: {
        ...updatedStudent,
        ...(updatedStudent ? decryptStudentPII(updatedStudent) : {}),
        user: updatedUserMap.get(userId) ?? null,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message === "EMAIL_TAKEN") {
      res.status(400).json({ success: false, error: "This email is already in use by another account" });
      return;
    }
    next(err);
  }
});

// ── POST /student/photo ───────────────────────────────────────────────────────
// multer runs before academicRoutingMiddleware (not via `...S`): busboy's internal
// stream events aren't reliably tracked as children of the AsyncLocalStorage scope
// academicRoutingMiddleware opens, so parsing the file first avoids the handler
// seeing "No academic client in context".
router.post("/photo", authMiddleware(["STUDENT"]), institutionAccessMiddleware, upload.single("photo"), academicRoutingMiddleware, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!req.file) {
      res.status(400).json({ success: false, error: "No photo file provided" });
      return;
    }

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!student) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }

    const { publicUrl } = await uploadImageToR2(req.file.buffer, {
      contentType: req.file.mimetype,
      folder: "student-photos",
      ownerId: student.id,
    });

    await academicDb().student.update({
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
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      select: { id: true, rollNo: true },
    });
    if (!student) {
      res.status(404).json({ success: false, error: "Student not found" });
      return;
    }
    const studentUserMap = await resolveUsers([userId], { id: true, name: true });
    const studentName = studentUserMap.get(userId)?.name ?? "";

    const year = await resolveRequestedAcademicYear(
      req.query.academicYearId as string | undefined,
      institutionId,
      { role: req.user!.role, userId }
    );

    // Academic year window comes from the resolved year's own dates, not
    // "today" — a historical selection sums only that year's records.
    const startYear = year.startDate.getFullYear();
    const academicYear = year.label;
    const toDateStr = (d: Date) => d.toISOString().slice(0, 10);
    const startDate = toDateStr(year.startDate);
    const endDate = toDateStr(year.endDate);

    const [records, holidays] = await Promise.all([
      academicDb().attendance.findMany({
        where: { studentId: student.id, institutionId, academicYearId: year.id, date: { gte: startDate, lte: endDate } },
        select: { date: true, status: true },
      }),
      academicDb().schoolHoliday.findMany({
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
        student: { name: studentName, rollNo: student.rollNo ?? "" },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /student/marksheet?academicYear= ──────────────────────────────────────
// Returns the logged-in student's own results, but ONLY if the class marksheet
// has been PUBLISHED. Draft marksheets are never visible to students.
function defaultYearLabel(): string {
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
    const academicYear = (req.query.academicYear as string) || defaultYearLabel();

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      include: {
        division: { select: { id: true, name: true, standardId: true, standard: { select: { name: true } } } },
      },
    });
    if (!student || !student.division) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }
    const marksheetUserMap = await resolveUsers([userId], { id: true, name: true });
    const marksheetStudentName = marksheetUserMap.get(userId)?.name ?? "";

    // The requested year's division may differ from the student's current one
    // (promotion, mid-year move) — resolve from that year's own enrollment
    // snapshot rather than always using the live division.
    const requestedYearRow = await academicDb().academicYear.findFirst({ where: { institutionId, label: academicYear } });
    let targetDivisionId = student.division.id;
    if (requestedYearRow && !requestedYearRow.isCurrent) {
      const enrollment = await academicDb().studentEnrollment.findFirst({
        where: { studentId: student.id, academicYearId: requestedYearRow.id, institutionId },
        select: { divisionId: true },
      });
      if (enrollment) targetDivisionId = enrollment.divisionId;
    }

    // Try the requested (or computed current) academic year first; if not found or
    // not published, fall back to the most recent published marksheet for this
    // division. This handles the common case where results from the just-finished
    // year (e.g. 2025-26) are viewed in June of the new year (2026-27).
    let marksheet = await academicDb().marksheet.findFirst({
      where: { divisionId: targetDivisionId, institutionId, academicYear: { label: academicYear } },
      select: { id: true, status: true, gradedSectionTitle: true, academicYear: { select: { label: true } }, pdfR2Key: true, gradeScale: true, publishedSnapshot: true },
    });
    if (!marksheet || marksheet.status !== "PUBLISHED") {
      marksheet = await academicDb().marksheet.findFirst({
        where: { divisionId: student.division.id, institutionId, status: "PUBLISHED" },
        orderBy: { academicYear: { label: "desc" } },
        select: { id: true, status: true, gradedSectionTitle: true, academicYear: { select: { label: true } }, pdfR2Key: true, gradeScale: true, publishedSnapshot: true },
      });
      console.log("[marksheet] fallback:", marksheet?.academicYear.label, "status:", marksheet?.status);
    }
    if (!marksheet) {
      res.status(404).json({ success: false, error: "Results not published yet" });
      return;
    }

    // Student-facing reads prefer the frozen publish-time snapshot so score
    // edits the teacher hasn't re-published yet stay invisible to students.
    // Marksheets published before this feature existed have no snapshot —
    // fall back to live tables for those (backward compatibility).
    const snap = marksheet.publishedSnapshot as {
      gradeScale?: GradeScaleEntry[];
      gradedSectionTitle?: string | null;
      examColumns: { id: string; subjectId: string; name: string; maxMarks: number; order?: number }[];
      scores: { studentId: string; examColumnId: string; score: number | null; isAbsent: boolean }[];
      gradedSubjects: { id: string; name: string }[];
      gradedScores: { gradedSubjectId: string; studentId: string; term1Grade: string | null; term2Grade: string | null }[];
      remarks: { studentId: string; conduct: string | null; remarks: string | null }[];
    } | null;

    const [subjects, examColumns, scores, gradedSubjects, gradedScores, remark] = snap
      ? await Promise.all([
          academicDb().subject.findMany({
            where: { standardId: student.division.standardId, institutionId },
            orderBy: { order: "asc" },
            select: { id: true, name: true, code: true, color: true },
          }),
          // The snapshot's own array order isn't guaranteed to match the
          // teacher's actual drag-reorder/add sequence (publishMarksheet's
          // capture query has no orderBy) — sort by the stored `order` field
          // explicitly, same as the live-table query below already does.
          Promise.resolve(
            [...snap.examColumns]
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .map((c) => ({ id: c.id, subjectId: c.subjectId, name: c.name, maxMarks: c.maxMarks }))
          ),
          Promise.resolve(snap.scores.filter((s) => s.studentId === student.id).map((s) => ({ examColumnId: s.examColumnId, score: s.score, isAbsent: s.isAbsent }))),
          Promise.resolve(snap.gradedSubjects.map((g) => ({ id: g.id, name: g.name }))),
          Promise.resolve(snap.gradedScores.filter((g) => g.studentId === student.id).map((g) => ({ gradedSubjectId: g.gradedSubjectId, term1Grade: g.term1Grade, term2Grade: g.term2Grade }))),
          Promise.resolve(snap.remarks.find((r) => r.studentId === student.id) ?? null),
        ])
      : await Promise.all([
          academicDb().subject.findMany({
            where: { standardId: student.division.standardId, institutionId },
            orderBy: { order: "asc" },
            select: { id: true, name: true, code: true, color: true },
          }),
          academicDb().marksheetExamColumn.findMany({
            where: { marksheetId: marksheet.id, institutionId },
            orderBy: [{ subjectId: "asc" }, { order: "asc" }],
            select: { id: true, subjectId: true, name: true, maxMarks: true },
          }),
          academicDb().marksheetScore.findMany({
            where: { marksheetId: marksheet.id, institutionId, studentId: student.id },
            select: { examColumnId: true, score: true, isAbsent: true },
          }),
          academicDb().marksheetGradedSubject.findMany({
            where: { marksheetId: marksheet.id, institutionId },
            orderBy: { order: "asc" },
            select: { id: true, name: true },
          }),
          academicDb().marksheetGradedScore.findMany({
            where: { marksheetId: marksheet.id, institutionId, studentId: student.id },
            select: { gradedSubjectId: true, term1Grade: true, term2Grade: true },
          }),
          academicDb().marksheetRemark.findFirst({
            where: { marksheetId: marksheet.id, institutionId, studentId: student.id },
            select: { conduct: true, remarks: true },
          }),
        ]);

    // gradeScale/gradedSectionTitle also freeze from the snapshot when present.
    const effectiveGradeScale = (snap?.gradeScale ?? marksheet.gradeScale ?? []) as GradeScaleEntry[];
    const effectiveGradedSectionTitle = snap ? (snap.gradedSectionTitle ?? null) : marksheet.gradedSectionTitle;

    const scoreByCol = new Map(scores.map((s) => [s.examColumnId, s]));
    const colsBySubject: Record<string, typeof examColumns> = {};
    for (const c of examColumns) (colsBySubject[c.subjectId] ??= []).push(c);

    // Online: same live-computed source the online marksheet tab and
    // leaderboard read from — no publish step of its own, always current.
    const online = await computeOnlineMarksheet(student.division.id, institutionId!, null);

    let grandScored = 0;
    let grandMax = 0;
    let onlineGrandScored = 0;
    let onlineGrandMax = 0;
    const subjectResults = subjects.map((sub) => {
      const cols = colsBySubject[sub.id] ?? [];
      let scored = 0;
      let max = 0;
      const columns = cols.map((c) => {
        const e = scoreByCol.get(c.id);
        const sc = e?.score ?? null;
        const absent = e?.isAbsent ?? false;
        // Matches the marksheet grid's own enteredTotal rule: a column only
        // counts toward max if this student has a real (non-null) score in
        // it — blank AND absent both mean "not entered" here.
        if (sc !== null) { scored += sc; max += c.maxMarks; }
        return { id: c.id, name: c.name, maxMarks: c.maxMarks, score: sc, isAbsent: absent };
      });
      grandScored += scored;
      grandMax += max;
      const pct = max > 0 ? Math.round((scored / max) * 100) : null;

      // Online: the test is already completed by the time it shows up here,
      // so a missing attempt means the student missed it — a hard 0, not an
      // unknown/blank value (unlike offline, where no entry = not graded yet).
      const onlineCols = online.examColumns[sub.id] ?? [];
      let onlineScored = 0;
      let onlineMax = 0;
      const onlineColumns = onlineCols.map((c) => {
        const e = online.scores[c.id]?.[student.id];
        const sc = e?.isAbsent ? null : (e?.score ?? 0);
        if (!e?.isAbsent) { onlineMax += c.maxMarks; if (sc !== null) onlineScored += sc; }
        return { id: c.id, name: c.name, maxMarks: c.maxMarks, score: sc, isAbsent: e?.isAbsent ?? false };
      });
      onlineGrandScored += onlineScored;
      onlineGrandMax += onlineMax;
      const onlinePct = onlineMax > 0 ? Math.round((onlineScored / onlineMax) * 100) : null;

      return {
        id: sub.id, name: sub.name, code: sub.code ?? sub.name.slice(0, 4), color: sub.color ?? null,
        columns, total: { scored, max }, pct, grade: gradeFor(pct, effectiveGradeScale),
        onlineColumns, onlineTotal: { scored: onlineScored, max: onlineMax }, onlinePct,
        onlineGrade: gradeFor(onlinePct, effectiveGradeScale),
      };
    });
    const grandPct = grandMax > 0 ? Math.round((grandScored / grandMax) * 100) : null;
    const onlineGrandPct = onlineGrandMax > 0 ? Math.round((onlineGrandScored / onlineGrandMax) * 100) : null;
    // Combined = offline + online pooled into one scored/max ratio (matches
    // the same "combined" mode used elsewhere, e.g. StudentProfileView).
    const combinedGrandMax = grandMax + onlineGrandMax;
    const combinedGrandScored = grandScored + onlineGrandScored;
    const combinedGrandPct = combinedGrandMax > 0 ? Math.round((combinedGrandScored / combinedGrandMax) * 100) : null;

    // Compute class rank by comparing this student's total against all others.
    // Uses the same frozen snapshot (all students' scores) when available, so
    // ranks don't shift from an unpublished edit either.
    const [allMarksheetScores, classSize] = await Promise.all([
      snap
        ? Promise.resolve(snap.scores.map((s) => ({ studentId: s.studentId, score: s.score, isAbsent: s.isAbsent })))
        : academicDb().marksheetScore.findMany({
            where: { marksheetId: marksheet.id, institutionId },
            select: { studentId: true, score: true, isAbsent: true },
          }),
      academicDb().student.count({
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

    // Online + combined rank, same "compare raw totals" approach as offline —
    // ranking by raw scored totals rather than %, so per-student differences
    // in entered max (some students may have fewer graded columns than
    // others at any given moment) don't need to be normalized out here.
    const onlineStudentTotals = new Map<string, number>();
    for (const studentScores of Object.values(online.scores)) {
      for (const [sid, entry] of Object.entries(studentScores)) {
        if (entry.isAbsent || entry.score === null) continue;
        onlineStudentTotals.set(sid, (onlineStudentTotals.get(sid) ?? 0) + entry.score);
      }
    }
    const onlineAboveMe = [...onlineStudentTotals.values()].filter((t) => t > onlineGrandScored).length;
    const onlineClassRank = onlineGrandMax > 0 ? onlineAboveMe + 1 : null;

    const allRankedIds = new Set([...studentTotals.keys(), ...onlineStudentTotals.keys(), student.id]);
    const combinedTotals = new Map<string, number>();
    for (const sid of allRankedIds) {
      combinedTotals.set(sid, (studentTotals.get(sid) ?? 0) + (onlineStudentTotals.get(sid) ?? 0));
    }
    const myCombinedTotal = grandScored + onlineGrandScored;
    const combinedAboveMe = [...combinedTotals.values()].filter((t) => t > myCombinedTotal).length;
    const combinedClassRank = (grandMax + onlineGrandMax) > 0 ? combinedAboveMe + 1 : null;

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
        academicYear: marksheet.academicYear.label,
        gradeScale: effectiveGradeScale,
        gradedSectionTitle: effectiveGradedSectionTitle,
        standardName: student.division.standard?.name ?? "",
        divisionName: student.division.name,
        student: { name: marksheetStudentName, rollNo: student.rollNo ?? "" },
        subjects: subjectResults,
        grandTotal: { scored: grandScored, max: grandMax },
        grandPct,
        grade: gradeFor(grandPct, effectiveGradeScale),
        onlineGrandTotal: { scored: onlineGrandScored, max: onlineGrandMax },
        onlineGrandPct,
        onlineGrade: gradeFor(onlineGrandPct, effectiveGradeScale),
        combinedGrandTotal: { scored: combinedGrandScored, max: combinedGrandMax },
        combinedGrandPct,
        combinedGrade: gradeFor(combinedGrandPct, effectiveGradeScale),
        classRank,
        offlineClassRank: classRank,
        onlineClassRank,
        combinedClassRank,
        classSize,
        gradedSubjects: gradedResults,
        conduct: remark?.conduct ?? null,
        remarks: remark?.remarks ?? null,
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

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      include: {
        division: { select: { id: true, name: true, standardId: true, standard: { select: { name: true } } } },
      },
    });
    const overviewUserMap = await resolveUsers([userId], { id: true, name: true });
    const overviewStudentName = overviewUserMap.get(userId)?.name ?? "";
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

    const attendanceRecords = await academicDb().attendance.findMany({
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
    let leaderboard: { rank: number; name: string; rollNo: string; pct: number; isMe: boolean; avatarUrl: string | null }[] = [];

    if (divisionId) {
      const marksheet = await academicDb().marksheet.findFirst({
        where: { divisionId, institutionId, status: "PUBLISHED" },
        orderBy: { academicYear: { label: "desc" } },
        select: { id: true, publishedSnapshot: true },
      });

      if (marksheet) {
        // Prefer the frozen publish-time snapshot so unpublished score edits
        // don't leak into the overview leaderboard. Falls back to live tables
        // for marksheets published before this feature existed.
        const overviewSnap = marksheet.publishedSnapshot as {
          examColumns: { id: string; maxMarks: number }[];
          scores: { studentId: string; examColumnId: string; score: number | null; isAbsent: boolean }[];
        } | null;

        const [allScores, allStudents] = await Promise.all([
          overviewSnap
            ? Promise.resolve(overviewSnap.scores)
            : academicDb().marksheetScore.findMany({
                where: { marksheetId: marksheet.id, institutionId },
                select: { studentId: true, examColumnId: true, score: true, isAbsent: true },
              }),
          academicDb().student.findMany({
            where: { divisionId, institutionId, status: "ACTIVE" },
            select: { id: true, userId: true, rollNo: true, avatarUrl: true },
          }),
        ]);
        const leaderboardUserMap = await resolveUsers(allStudents.map((s) => s.userId), { id: true, name: true });

        const allCols = overviewSnap
          ? overviewSnap.examColumns
          : await academicDb().marksheetExamColumn.findMany({
              where: { marksheetId: marksheet.id, institutionId },
              select: { id: true, maxMarks: true },
            });
        const maxByCol = new Map(allCols.map((c) => [c.id, c.maxMarks]));

        // total scored per student, PLUS each student's own entered max — a
        // freshly created exam column with no marks filled in yet must not
        // drag anyone's % down, same "only columns actually graded count
        // toward the denominator" rule the marksheet grid itself uses.
        const totals = new Map<string, number>();
        const maxByStudent = new Map<string, number>();
        for (const sc of allScores) {
          if (!sc.isAbsent && sc.score !== null) {
            totals.set(sc.studentId, (totals.get(sc.studentId) ?? 0) + sc.score);
            const colMax = maxByCol.get(sc.examColumnId) ?? 0;
            maxByStudent.set(sc.studentId, (maxByStudent.get(sc.studentId) ?? 0) + colMax);
          }
        }

        totalStudents = allStudents.length;
        const myTotal = totals.get(student.id) ?? 0;
        const myMax = maxByStudent.get(student.id) ?? 0;
        marksPct = myMax > 0 ? Math.round((myTotal / myMax) * 100) : null;
        classRank = [...totals.values()].filter(t => t > myTotal).length + 1;

        // Build leaderboard: sort all students by score desc, take top 5
        const ranked = allStudents
          .map(s => {
            const sMax = maxByStudent.get(s.id) ?? 0;
            return {
              id: s.id,
              name: leaderboardUserMap.get(s.userId)?.name ?? "Unknown",
              rollNo: s.rollNo ?? "",
              avatarUrl: s.avatarUrl ?? null,
              total: totals.get(s.id) ?? 0,
              pct: sMax > 0 ? Math.round(((totals.get(s.id) ?? 0) / sMax) * 100) : 0,
            };
          })
          .sort((a, b) => b.total - a.total);

        leaderboard = ranked.slice(0, 5).map((s, i) => ({
          rank: i + 1,
          name: s.name,
          rollNo: s.rollNo,
          pct: s.pct,
          isMe: s.id === student.id,
          avatarUrl: s.avatarUrl,
        }));
      }
    }

    // ── Pending tasks (active assignments for this division) ──────────────────
    const pendingTasks = divisionId
      ? await academicDb().taskAssignment.count({
          where: { divisionId, institutionId, status: "ACTIVE" },
        })
      : 0;

    // ── Next upcoming event (test/exam/submission/etc.) ───────────────────────
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const nextEventRow = divisionId
      ? await academicDb().calendarEvent.findFirst({
          where: {
            institutionId,
            date: { gte: todayStart },
            OR: [{ divisionId: null }, { divisionId }],
          },
          orderBy: { date: "asc" },
          select: { type: true, label: true, date: true },
        })
      : await academicDb().calendarEvent.findFirst({
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
    const latestPost = await academicDb().campusFeedPost.findFirst({
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
          name: overviewStudentName,
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

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!student) {
      res.status(404).json({ success: false, error: "Student not found" });
      return;
    }

    const remarks = await listStudentRemarks(student.id, institutionId!, { userId, role: "STUDENT" });
    res.json({ success: true, data: remarks });
  } catch (err) {
    next(err);
  }
});

// ── POST /student/translate — Parent Mode dynamic text (Hindi/Marathi) ──────
// Translates teacher-entered free text (Marksheet Conduct/Remarks, flag
// category/title/detail/actionTaken/reviewRemark, PTM notes) that can't be
// covered by the app's static UI-text dictionary. Only 'hi'/'mr' are valid —
// the app never calls this for English or Hinglish (Hinglish isn't a real
// language a translation API can target, so dynamic text stays in its
// original language when Hinglish is selected).
const translateBodySchema = z.object({
  texts: z.array(z.string()).max(100),
  lang: z.enum(["hi", "mr"]),
});
router.post("/translate", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = translateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid request body", details: parsed.error.flatten() });
      return;
    }
    const { texts, lang } = parsed.data;
    const translated = await translateBatch(texts, lang as DynamicTranslateLang);
    res.json({ success: true, data: { texts: translated } });
  } catch (err) {
    next(err);
  }
});

// ── POST /student/parent-mode/log — Parent Mode open event ─────────────────
// Fired once whenever Parent Mode is switched on, so admin insights can flag
// families who haven't checked their child's attendance/marks/fee status
// recently. Deliberately fire-and-forget from the app's point of view (it
// doesn't need the response) — this just needs to not fail loudly, so a
// missed log here never blocks the parent from actually using Parent Mode.
router.post("/parent-mode/log", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution associated with this account" });
      return;
    }
    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!student) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }
    await academicDb().parentModeEvent.create({
      data: { studentId: student.id, institutionId },
    });
    // Admin's "Parent Engagement" card caches its computed list for 5 minutes
    // (see getParentEngagementInsights) — without this, a parent opening
    // Parent Mode right now would still show as "Never opened" there until
    // the cache happened to expire, same staleness bug the attendance insight
    // had before its cache got a matching bust-on-write.
    await delCache(`insights:parent-engagement:${institutionId}`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── PTM Notes — read own history + acknowledge, from the app's Parent Mode ──
router.get("/ptm-notes", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!student) {
      res.status(404).json({ success: false, error: "Student not found" });
      return;
    }

    const notes = await listPTMNotes(student.id, institutionId!);
    res.json({ success: true, data: notes });
  } catch (err) {
    next(err);
  }
});

router.patch("/ptm-notes/:noteId/acknowledge", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    const noteId = req.params.noteId as string;

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!student) {
      res.status(404).json({ success: false, error: "Student not found" });
      return;
    }

    const updated = await acknowledgePTMNote({ noteId, studentId: student.id, institutionId: institutionId! });
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) {
      res.status(e.status).json({ success: false, error: e.message });
      return;
    }
    next(err);
  }
});

// ── GET /student/class — division info, classmates, my subject scores ────────
router.get("/class", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      include: {
        division: {
          include: {
            standard: { select: { id: true, name: true } },
            assignments: {
              include: {
                teacher: true,
                subject: { select: { id: true, name: true, code: true, color: true, order: true } },
              },
            },
            classTeacher: true,
            _count: { select: { students: { where: { status: "ACTIVE" } } } },
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

    const classUserIds = [
      ...division.assignments.map(a => a.teacher.userId),
      ...(division.classTeacher ? [division.classTeacher.userId] : []),
    ];
    const classTeacherUserMap = await resolveUsers(classUserIds, { id: true, name: true });

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
        teacherName: classTeacherUserMap.get(a.teacher.userId)?.name ?? "Unknown",
        teacherPrefix: a.teacher.prefix,
        teacherAvatarUrlRaw: (a.teacher as { avatarUrl?: string | null }).avatarUrl ?? null,
      }));

    // ── Classmates with attendance % and marks % ─────────────────────────────
    const [allStudents, attendanceRecords] = await Promise.all([
      academicDb().student.findMany({
        where: { divisionId, institutionId },
        orderBy: [{ rollNo: "asc" }],
      }),
      academicDb().attendance.findMany({
        where: { divisionId, institutionId, date: { gte: ayStart, lte: ayEnd } },
        select: { studentId: true, status: true },
      }),
    ]);
    const classmateUserMap = await resolveUsers(allStudents.map(s => s.userId), { id: true, name: true });

    // Batch-sign all avatar URLs (students + teachers) in one round-trip
    const rawAvatarUrls: (string | null | undefined)[] = [
      ...allStudents.map(s => (s as { avatarUrl?: string | null }).avatarUrl),
      ...subjectListRaw.map(s => s.teacherAvatarUrlRaw),
      (division.classTeacher as { avatarUrl?: string | null } | null)?.avatarUrl,
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
      teacherPrefix: s.teacherPrefix,
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
      academicDb().campusFeedPost.findMany({
        where: { divisionId, institutionId, type: { in: ["RESULT", "MATERIAL"] } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, type: true, title: true, subject: true, subjectId: true,
          attachmentUrl: true, attachmentType: true, attachmentName: true, createdAt: true,
          authorId: true,
        },
      }),
      // Fetch all published marksheets for scoring/leaderboard only
      academicDb().marksheet.findMany({
        where: { divisionId, institutionId, status: "PUBLISHED" },
        orderBy: { academicYear: { label: "desc" } },
        select: { id: true, publishedSnapshot: true },
      }),
    ]);

    const feedAuthorUserMap = await resolveUsers(feedPosts.map(p => p.authorId), { id: true, name: true, role: true });
    const feedAuthors = [...feedAuthorUserMap.values()].map(u => ({ id: u.id, role: u.role }));
    const feedAuthorDisplayMap = await resolveAuthorDisplay(feedAuthors, institutionId!);
    const postedByOf = (p: (typeof feedPosts)[number]) => {
      const author = feedAuthorUserMap.get(p.authorId);
      return author?.name ? formatDisplayName(author.name, feedAuthorDisplayMap.get(author.id)?.prefix) : "—";
    };

    // Separate into results and materials
    const resultFiles = feedPosts
      .filter(p => p.type === "RESULT")
      .map(p => ({
        id: p.id,
        title: p.title,
        attachmentUrl: p.attachmentUrl,
        attachmentType: p.attachmentType,
        attachmentName: p.attachmentName,
        postedBy: postedByOf(p),
        createdAt: p.createdAt.toISOString(),
      }));

    // Materials grouped by subjectId (exact match — set at creation time via a
    // subject picker, so this can't drift like free-text subject names could).
    // Posts with no subjectId are class-wide/general materials (e.g. posted by
    // the class teacher) and are surfaced separately in `generalMaterials`.
    // Legacy posts created before subjectId existed fall back to name matching.
    const materialsRaw = feedPosts.filter(p => p.type === "MATERIAL");
    const subjectMaterialsByIdMap = new Map<string, typeof materialsRaw>();
    const subjectMaterialsByNameMap = new Map<string, typeof materialsRaw>();
    const generalMaterialsRaw: typeof materialsRaw = [];
    for (const m of materialsRaw) {
      if (m.subjectId) {
        const arr = subjectMaterialsByIdMap.get(m.subjectId) ?? [];
        arr.push(m);
        subjectMaterialsByIdMap.set(m.subjectId, arr);
      } else if (m.subject && m.subject.trim()) {
        const key = m.subject.toLowerCase().trim();
        const arr = subjectMaterialsByNameMap.get(key) ?? [];
        arr.push(m);
        subjectMaterialsByNameMap.set(key, arr);
      } else {
        generalMaterialsRaw.push(m);
      }
    }

    // Use the most recent published marksheet for leaderboard/scoring
    const marksheet = allMarksheets[0] ?? null;

    const marksMap = new Map<string, number>(); // studentId → total combined scored
    const offlineMarksMap = new Map<string, number>(); // studentId → offline scored
    // studentId → offline entered max — per-student, NOT a class-wide
    // constant. A freshly added exam column with no marks filled in yet must
    // not drag anyone's % down; only columns a student actually has a score
    // for count toward their own denominator, same rule the marksheet grid
    // itself uses.
    const offlineMaxByStudent = new Map<string, number>();
    const onlineMarksMap = new Map<string, number>(); // studentId → online scored
    let grandMax = 0;
    let onlineGrandMax = 0;
    let allColumns: { id: string; subjectId: string; name: string; maxMarks: number }[] = [];
    let allScoreRows: { studentId: string; examColumnId: string; score: number | null; isAbsent: boolean }[] = [];
    type ScoreCol = { name: string; scored: number | null; max: number; isAbsent: boolean };
    let mySubjectScores: {
      subjectId: string; subjectName: string; subjectCode: string; subjectColor: string;
      // Combined (offline + online together) — kept for backward compatibility.
      columns: ScoreCol[]; totalScored: number; totalMax: number; pct: number | null;
      // Split out so the UI's offline/online/combined toggle can show the
      // right trend chart + results list instead of always the merged one.
      offlineColumns: ScoreCol[]; offlineTotalScored: number; offlineTotalMax: number; offlinePct: number | null;
      onlineColumns: ScoreCol[]; onlineTotalScored: number; onlineTotalMax: number; onlinePct: number | null;
    }[] = [];

    // Online: auto-computed live from completed tests + attempts (best
    // attempt per student per test) — same source the online marksheet tab
    // and leaderboard read from. Computed unconditionally (no offline
    // marksheet required), unlike offline which needs a published sheet.
    const online = await computeOnlineMarksheet(divisionId, institutionId!, null);
    const onlineColumnsFlat = Object.values(online.examColumns).flat();
    for (const c of onlineColumnsFlat) onlineGrandMax += c.maxMarks;
    for (const studentScores of Object.values(online.scores)) {
      for (const [sid, entry] of Object.entries(studentScores)) {
        if (entry.isAbsent || entry.score === null) continue;
        onlineMarksMap.set(sid, (onlineMarksMap.get(sid) ?? 0) + entry.score);
      }
    }

    if (marksheet) {

      // Prefer the frozen publish-time snapshot (offline scores) so unpublished
      // edits stay invisible to students/classmates on this page. Old
      // marksheets published before this feature existed have no snapshot —
      // fall back to live tables.
      const classSnap = marksheet.publishedSnapshot as {
        examColumns: { id: string; subjectId: string; name: string; maxMarks: number; order?: number }[];
        scores: { studentId: string; examColumnId: string; score: number | null; isAbsent: boolean }[];
      } | null;

      const [columns, allScores, myScoresRaw] = classSnap
        ? [
            // The snapshot's own array order isn't guaranteed to match the
            // teacher's actual drag-reorder/add sequence (publishMarksheet's
            // capture query has no orderBy) — sort by the stored `order`
            // field explicitly, same as the live-table query below does.
            [...classSnap.examColumns].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
            classSnap.scores,
            classSnap.scores.filter((s) => s.studentId === student.id).map((s) => ({ examColumnId: s.examColumnId, score: s.score, isAbsent: s.isAbsent })),
          ]
        : await Promise.all([
            academicDb().marksheetExamColumn.findMany({
              where: { marksheetId: marksheet.id, institutionId },
              orderBy: [{ subjectId: "asc" }, { order: "asc" }],
              select: { id: true, subjectId: true, name: true, maxMarks: true },
            }),
            academicDb().marksheetScore.findMany({
              where: { marksheetId: marksheet.id, institutionId },
              select: { studentId: true, examColumnId: true, score: true, isAbsent: true },
            }),
            academicDb().marksheetScore.findMany({
              where: { marksheetId: marksheet.id, institutionId, studentId: student.id },
              select: { examColumnId: true, score: true, isAbsent: true },
            }),
          ]);

      allColumns = columns;
      allScoreRows = allScores;

      const maxByCol = new Map(columns.map((c) => [c.id, c.maxMarks]));

      // Per-student offline totals + per-student entered max
      for (const sc of allScores) {
        if (!sc.isAbsent && sc.score !== null) {
          offlineMarksMap.set(sc.studentId, (offlineMarksMap.get(sc.studentId) ?? 0) + sc.score);
          const colMax = maxByCol.get(sc.examColumnId) ?? 0;
          offlineMaxByStudent.set(sc.studentId, (offlineMaxByStudent.get(sc.studentId) ?? 0) + colMax);
        }
      }

      // My subject-wise scores (offline columns + online tests, side by side)
      const myScoreByCol = new Map(myScoresRaw.map(s => [s.examColumnId, s]));
      const colsBySubject = new Map<string, typeof columns>();
      for (const c of columns) {
        const arr = colsBySubject.get(c.subjectId) ?? [];
        arr.push(c);
        colsBySubject.set(c.subjectId, arr);
      }

      for (const subj of subjectList) {
        const cols = colsBySubject.get(subj.id) ?? [];
        const onlineCols = online.examColumns[subj.id] ?? [];
        if (cols.length === 0 && onlineCols.length === 0) continue;
        const offCols: ScoreCol[] = cols.map(c => {
          const s = myScoreByCol.get(c.id);
          return { name: c.name, scored: s?.score ?? null, max: c.maxMarks, isAbsent: s?.isAbsent ?? false };
        });
        const onCols: ScoreCol[] = onlineCols.map(c => {
          const e = online.scores[c.id]?.[student.id];
          // Online tests are already completed by the time they appear here,
          // so no recorded attempt means missed — a real 0, not a blank.
          const sc = e?.isAbsent ? null : (e?.score ?? 0);
          return { name: c.name, scored: sc, max: c.maxMarks, isAbsent: e?.isAbsent ?? false };
        });
        const sumScored = (cs: ScoreCol[]) => cs.reduce((s, c) => s + (c.isAbsent ? 0 : (c.scored ?? 0)), 0);
        // A column only counts toward max if this student has a real
        // (non-null) `scored` value — matches the marksheet grid's own
        // enteredTotal rule. Offline: blank AND absent both read as null
        // here, so neither inflates/shrinks the max. Online: a column is
        // only null when explicitly absent (a merely-missed test already
        // defaults to a real 0 above), so it still counts in full otherwise.
        const sumMax = (cs: ScoreCol[]) => cs.reduce((s, c) => s + (c.scored !== null ? c.max : 0), 0);
        const offTotalScored = sumScored(offCols), offTotalMax = sumMax(offCols);
        const onTotalScored = sumScored(onCols), onTotalMax = sumMax(onCols);
        const subCols = [...offCols, ...onCols];
        const totalMax = offTotalMax + onTotalMax;
        const totalScored = offTotalScored + onTotalScored;
        mySubjectScores.push({
          subjectId: subj.id, subjectName: subj.name, subjectCode: subj.code ?? "", subjectColor: subj.color,
          columns: subCols, totalScored, totalMax, pct: totalMax > 0 ? Math.round((totalScored / totalMax) * 100) : null,
          offlineColumns: offCols, offlineTotalScored: offTotalScored, offlineTotalMax: offTotalMax,
          offlinePct: offTotalMax > 0 ? Math.round((offTotalScored / offTotalMax) * 100) : null,
          onlineColumns: onCols, onlineTotalScored: onTotalScored, onlineTotalMax: onTotalMax,
          onlinePct: onTotalMax > 0 ? Math.round((onTotalScored / onTotalMax) * 100) : null,
        });
      }
    } else {
      // No offline marksheet published yet, but online tests may still exist
      // — still surface a per-subject breakdown built from online data alone.
      for (const subj of subjectList) {
        const onlineCols = online.examColumns[subj.id] ?? [];
        if (onlineCols.length === 0) continue;
        const onCols: ScoreCol[] = onlineCols.map(c => {
          const e = online.scores[c.id]?.[student.id];
          const sc = e?.isAbsent ? null : (e?.score ?? 0);
          return { name: c.name, scored: sc, max: c.maxMarks, isAbsent: e?.isAbsent ?? false };
        });
        const onTotalMax = onCols.reduce((s, c) => s + (c.isAbsent ? 0 : c.max), 0);
        const onTotalScored = onCols.reduce((s, c) => s + (c.isAbsent ? 0 : (c.scored ?? 0)), 0);
        mySubjectScores.push({
          subjectId: subj.id, subjectName: subj.name, subjectCode: subj.code ?? "", subjectColor: subj.color,
          columns: onCols, totalScored: onTotalScored, totalMax: onTotalMax,
          pct: onTotalMax > 0 ? Math.round((onTotalScored / onTotalMax) * 100) : null,
          offlineColumns: [], offlineTotalScored: 0, offlineTotalMax: 0, offlinePct: null,
          onlineColumns: onCols, onlineTotalScored: onTotalScored, onlineTotalMax: onTotalMax,
          onlinePct: onTotalMax > 0 ? Math.round((onTotalScored / onTotalMax) * 100) : null,
        });
      }
    }

    // Combined = offline + online, pooled scored / pooled max — same rule
    // used by the leaderboard and Overall tab everywhere else. Max is
    // per-student on the offline side (only their own entered columns),
    // online max stays class-wide since every student is scored against the
    // same completed tests either way.
    grandMax = onlineGrandMax; // existence flag only (see `rank` below) — real per-student max computed inline
    for (const s of allStudents) {
      const off = offlineMarksMap.get(s.id);
      const on = onlineMarksMap.get(s.id);
      if (off === undefined && on === undefined) continue;
      marksMap.set(s.id, (off ?? 0) + (on ?? 0));
    }

    // Build ranked classmates (sorted by combined score)
    const sorted = [...allStudents].sort((a, b) => (marksMap.get(b.id) ?? -1) - (marksMap.get(a.id) ?? -1));
    const classmates = sorted.map((s, i) => {
      const att = attMap.get(s.id);
      const attPct = att && att.total > 0 ? Math.round((att.p / att.total) * 100) : null;
      const scored = marksMap.get(s.id) ?? null;
      const offlineMaxForStudent = offlineMaxByStudent.get(s.id) ?? 0;
      const combinedMaxForStudent = offlineMaxForStudent + onlineGrandMax;
      const marksPct = scored !== null && combinedMaxForStudent > 0 ? Math.round((scored / combinedMaxForStudent) * 100) : null;
      const offlineScored = offlineMarksMap.get(s.id) ?? null;
      const offlinePct = offlineScored !== null && offlineMaxForStudent > 0 ? Math.round((offlineScored / offlineMaxForStudent) * 100) : null;
      // Online: tests are already completed by the time they show up here, so
      // a student with no recorded attempt still gets a real 0%, not a dash
      // — same "missed means 0" rule used by the leaderboard/online marksheet.
      const onlinePct = onlineGrandMax > 0 ? Math.round(((onlineMarksMap.get(s.id) ?? 0) / onlineGrandMax) * 100) : null;
      return {
        id: s.id,
        name: classmateUserMap.get(s.userId)?.name ?? "Unknown",
        rollNo: s.rollNo ?? "—",
        rank: combinedMaxForStudent > 0 ? i + 1 : null,
        attendancePct: attPct,
        marksPct,
        offlinePct,
        onlinePct,
        isMe: s.id === student.id,
        avatarUrl: studentAvatarMap.get(s.id) ?? null,
      };
    });

    // ── Per-subject leaderboards (top 5, with combined/offline/online) ────────
    // Offline columns come from the published marksheet (real per-column
    // scores); online columns come from `computeOnlineMarksheet` (real
    // completed tests + best attempts) — no more guessing "online" by column
    // name, since online tests never lived in MarksheetExamColumn to begin
    // with.
    type LbEntry = { name: string; avatarUrl: string | null; combinedPct: number; offlinePct: number | null; onlinePct: number | null; isMe: boolean };
    const subjectLeaderboards: Record<string, LbEntry[]> = {};
    {
      const colSubjectMap = new Map(allColumns.map(c => [c.id, c.subjectId]));
      const colMaxMap = new Map(allColumns.map(c => [c.id, c.maxMarks]));

      const subjectOnlineMaxMap = new Map<string, number>();
      for (const cols of Object.values(online.examColumns)) {
        for (const c of cols) subjectOnlineMaxMap.set(c.subjectId, (subjectOnlineMaxMap.get(c.subjectId) ?? 0) + c.maxMarks);
      }

      const subjectStudentOffline = new Map<string, Map<string, number>>();
      const subjectStudentOnline = new Map<string, Map<string, number>>();
      // Per-subject, per-student entered offline max — NOT a subject-wide
      // constant. A freshly added column with no marks yet must not drag
      // down everyone's subject %; only columns a student actually has a
      // score for count toward their own denominator.
      const subjectStudentOfflineMax = new Map<string, Map<string, number>>();

      for (const sc of allScoreRows) {
        if (!sc.isAbsent && sc.score !== null) {
          const subjectId = colSubjectMap.get(sc.examColumnId);
          if (!subjectId) continue;
          const fMap = subjectStudentOffline.get(subjectId) ?? new Map<string, number>();
          fMap.set(sc.studentId, (fMap.get(sc.studentId) ?? 0) + sc.score);
          subjectStudentOffline.set(subjectId, fMap);
          const mMap = subjectStudentOfflineMax.get(subjectId) ?? new Map<string, number>();
          const colMax = colMaxMap.get(sc.examColumnId) ?? 0;
          mMap.set(sc.studentId, (mMap.get(sc.studentId) ?? 0) + colMax);
          subjectStudentOfflineMax.set(subjectId, mMap);
        }
      }
      for (const [subjectId, cols] of Object.entries(online.examColumns)) {
        for (const c of cols) {
          const entries = online.scores[c.id] ?? {};
          for (const [sid, e] of Object.entries(entries)) {
            if (e.isAbsent || e.score === null) continue;
            const oMap = subjectStudentOnline.get(subjectId) ?? new Map<string, number>();
            oMap.set(sid, (oMap.get(sid) ?? 0) + e.score);
            subjectStudentOnline.set(subjectId, oMap);
          }
        }
      }

      const studentNameMap = new Map<string, string>();
      for (const s of allStudents) studentNameMap.set(s.id, classmateUserMap.get(s.userId)?.name ?? "—");

      for (const subj of subjectList) {
        const onMax = subjectOnlineMaxMap.get(subj.id) ?? 0;
        const offMaxMapForSubj = subjectStudentOfflineMax.get(subj.id);
        const offMapForSubj = subjectStudentOffline.get(subj.id);
        const onMapForSubj = subjectStudentOnline.get(subj.id);
        const studentIds = new Set([...(offMapForSubj?.keys() ?? []), ...(onMapForSubj?.keys() ?? [])]);
        if (studentIds.size === 0 && onMax === 0) { subjectLeaderboards[subj.id] = []; continue; }
        subjectLeaderboards[subj.id] = [...studentIds]
          .map((sid): LbEntry => {
            const offScored = offMapForSubj?.get(sid) ?? null;
            const onScored = onMapForSubj?.get(sid) ?? null;
            const offMax = offMaxMapForSubj?.get(sid) ?? 0;
            const combinedMax = offMax + onMax;
            const total = (offScored ?? 0) + (onScored ?? 0);
            return {
              name: studentNameMap.get(sid) ?? "—",
              avatarUrl: studentAvatarMap.get(sid) ?? null,
              combinedPct: combinedMax > 0 ? Math.round((total / combinedMax) * 100) : 0,
              offlinePct: offScored !== null && offMax > 0 ? Math.round((offScored / offMax) * 100) : null,
              onlinePct: onMax > 0 ? Math.round(((onScored ?? 0) / onMax) * 100) : null,
              isMe: sid === student.id,
            };
          })
          .sort((a, b) => b.combinedPct - a.combinedPct)
          .slice(0, 5);
      }
    }

    // Build per-subject materials — prefer exact subjectId match, falling back
    // to legacy name-based matching for posts created before subjectId existed.
    type MaterialEntry = { id: string; title: string; attachmentUrl: string | null; attachmentType: string | null; attachmentName: string | null; postedBy: string; createdAt: string };
    const toEntry = (p: (typeof materialsRaw)[number]): MaterialEntry => ({
      id: p.id, title: p.title,
      attachmentUrl: p.attachmentUrl,
      attachmentType: p.attachmentType,
      attachmentName: p.attachmentName,
      postedBy: postedByOf(p),
      createdAt: p.createdAt.toISOString(),
    });
    const subjectMaterials: Record<string, MaterialEntry[]> = {};
    for (const subj of subjectList) {
      const byId = subjectMaterialsByIdMap.get(subj.id) ?? [];
      const byName = subjectMaterialsByNameMap.get(subj.name.toLowerCase().trim()) ?? [];
      subjectMaterials[subj.id] = [...byId, ...byName]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(toEntry);
    }
    const generalMaterials: MaterialEntry[] = generalMaterialsRaw.map(toEntry);

    res.json({
      success: true,
      data: {
        division: {
          id: division.id,
          name: division.name,
          standardName: division.standard.name,
          classTeacherName: (division.classTeacher ? classTeacherUserMap.get(division.classTeacher.userId)?.name : null) ?? null,
          classTeacherPrefix: division.classTeacher?.prefix ?? null,
          classTeacherAvatarUrl: resolveAvatar((division.classTeacher as { avatarUrl?: string | null } | null)?.avatarUrl),
          totalStudents: division._count.students,
          subjects: subjectList,
          timetableUrl: division.timetableUrl,
        },
        resultFiles,
        subjectMaterials,
        generalMaterials,
        classmates,
        myScores: mySubjectScores,
        subjectLeaderboards,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /student/fees — own fee structure + own payment status only ──────────
// Read-only, own-data-only: the fee structure (amounts/bank details/rules) is
// division-wide and shared with every student in the division, but payment
// records are filtered to this student's own — a student must never see a
// classmate's payment status.
router.get("/fees", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution associated with this account" });
      return;
    }

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      select: { id: true, divisionId: true, extraDetailFields: true },
    });
    if (!student || !student.divisionId) {
      res.json({ success: true, data: { structure: null, payments: [], extraDetailFields: null } });
      return;
    }

    const year = await resolveRequestedAcademicYear(
      req.query.academicYearId as string | undefined,
      institutionId,
      { role: req.user!.role, userId }
    );

    // The requested year's division may differ from the student's current
    // one (promotion, mid-year move) — resolve from that year's own
    // enrollment snapshot rather than always using the live division.
    let feeDivisionId = student.divisionId;
    if (!year.isCurrent) {
      const enrollment = await academicDb().studentEnrollment.findFirst({
        where: { studentId: student.id, academicYearId: year.id, institutionId },
        select: { divisionId: true },
      });
      if (enrollment) feeDivisionId = enrollment.divisionId;
    }

    const structure = await academicDb().divisionFeeStructure.findFirst({
      where: { divisionId: feeDivisionId, institutionId, academicYearId: year.id },
    });

    // StudentFeePayment has no academicYearId of its own — payment status
    // always reflects live data regardless of which year is selected (same
    // scope cut as the admin/teacher fee screens).
    const payments = await academicDb().studentFeePayment.findMany({
      where: { institutionId, studentId: student.id },
      select: { feeMonthId: true, status: true, paidDate: true, remark: true, extraFields: true, extraStructureIds: true },
    });

    // Paid / still due per month (part payments too) and the receipts from the
    // school's fee counter. Never blocks the page if it fails.
    const money = structure ? await studentMoney(institutionId, year, student.id, feeDivisionId).catch(() => null) : null;

    res.json({
      success: true,
      data: {
        structure: structure
          ? {
              feeStructures: structure.feeStructures,
              feeMonths: structure.feeMonths,
              bankDetails: structure.bankDetails,
              qrImageUrl: structure.qrImageUrl,
              extraColumns: structure.extraColumns,
              studentFields: structure.extraStudentFields,
              generalRemark: structure.generalRemark,
              feeCardTheme: structure.feeCardTheme ?? null,
              schoolLogoUrl: structure.schoolLogoUrl ?? null,
              schoolName: structure.schoolName ?? null,
              rulesAndRegs: structure.rulesAndRegs ?? [],
            }
          : null,
        payments: payments.map((p) => ({
          feeMonthId: p.feeMonthId,
          status: p.status === "PAID" ? "PAID" : "PENDING",
          paidDate: p.paidDate,
          remark: p.remark,
          extraFields: (p.extraFields as Record<string, string> | null) ?? null,
          extraStructureIds: (p.extraStructureIds as string[] | null) ?? null,
        })),
        extraDetailFields: (student.extraDetailFields as Record<string, string> | null) ?? null,
        money,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /student/fees/receipts/:id — one of the student's own fee receipts (to print) ─
router.get("/fees/receipts/:id", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution associated with this account" });
      return;
    }
    const student = await academicDb().student.findFirst({ where: { userId, institutionId }, select: { id: true } });
    if (!student) {
      res.status(404).json({ success: false, error: "Student not found" });
      return;
    }
    res.json({ success: true, data: await getReceipt(institutionId, String(req.params.id), student.id) });
  } catch (err) {
    next(err);
  }
});

// ── GET /student/feed/debug — temp: verify student division & class post counts ─
router.get("/feed/debug", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await academicDb().student.findFirst({
      where: { userId, institutionId },
      select: { id: true, divisionId: true, division: { select: { id: true, name: true } } },
    });

    const generalPostCount = await academicDb().campusFeedPost.count({
      where: { institutionId, divisionId: null },
    });

    const classPostCount = student?.divisionId
      ? await academicDb().campusFeedPost.count({ where: { institutionId, divisionId: student.divisionId } })
      : 0;

    const allClassPostCount = await academicDb().campusFeedPost.count({
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

    const student = await academicDb().student.findFirst({
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

    const [postsRaw, total] = await academicDb().$transaction([
      academicDb().campusFeedPost.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      academicDb().campusFeedPost.count({ where }),
    ]);

    console.log(`[student/feed/posts] total=${total} class_posts=${postsRaw.filter(p => p.divisionId).length} general_posts=${postsRaw.filter(p => !p.divisionId).length}`);

    const feedPostsAuthorUserMap = await resolveUsers(postsRaw.map(p => p.authorId), { id: true, name: true, role: true });
    const posts = postsRaw.map(p => ({ ...p, author: feedPostsAuthorUserMap.get(p.authorId) ?? { id: p.authorId, name: null, role: "ADMIN" } }));

    const displayMap = await resolveAuthorDisplay(posts.map(p => p.author), institutionId!);
    const rawFeedAvatars = posts.map(p => displayMap.get(p.author.id)?.avatarUrl ?? null);
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
          avatarUrl: resolveFeedAvatar(displayMap.get(p.author.id)?.avatarUrl),
          prefix: displayMap.get(p.author.id)?.prefix ?? null,
          title: displayMap.get(p.author.id)?.title ?? null,
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

    const student = await academicDb().student.findFirst({
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

    const events = await academicDb().calendarEvent.findMany({
      where,
      orderBy: { date: "asc" },
    });
    const studentEventCreatorUserMap = await resolveUsers(events.map(e => e.createdById), { id: true, name: true });

    res.json({
      success: true,
      data: events.map(e => ({
        id: e.id,
        type: e.type.toLowerCase(),
        label: e.label,
        date: e.date.getUTCDate(),
        fullDate: e.date.toISOString(),
        isClassEvent: !!e.divisionId,
        createdBy: studentEventCreatorUserMap.get(e.createdById) ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
