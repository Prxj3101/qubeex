// src/modules/student/tasks.controller.ts
import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { submitTestSchema } from "./tasks.schema";
import {
  seededRng,
  shuffleArray,
  personaliseQuestion,
  selectSectionAwareQuestions,
  parseSections,
} from "../teacher/tasks.controller";
import { uploadAttachmentToR2 } from "../../services/storage.service";
import { generateTestResultPdf } from "../../services/testResultPdf.service";
import { generateAssignmentPaperPdf } from "../../services/assignmentPaperPdf.service";
import { prisma } from "../../utils/prisma";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");

export const assignmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req: unknown, file: { mimetype: string }, cb: (err: Error | null, ok: boolean) => void) => {
    if (file.mimetype === "application/pdf") return cb(null, true);
    cb(new BadRequestError("Only PDF files are accepted for assignment submission"), false);
  },
});

async function getStudentForRequest(
  req: AuthRequest
): Promise<{ id: string; institutionId: string; divisionId: string; rollNo: string; name: string; studentId: string }> {
  const { userId, institutionId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  const student = await academicDb().student.findFirst({
    where: { userId, institutionId },
    select: { id: true, divisionId: true, rollNo: true, userId: true, studentId: true },
  });
  if (!student) throw new NotFoundError("Student profile not found");
  if (!student.divisionId) throw new BadRequestError("You are not assigned to a division yet");
  if (!student.rollNo) throw new BadRequestError("Your roll number is not set — contact your teacher");
  const studentName = (await resolveUsers([student.userId], { id: true, name: true })).get(student.userId)?.name;
  if (!studentName) throw new BadRequestError("Your name is not set — contact your teacher");

  return {
    id: student.id,
    institutionId,
    divisionId: student.divisionId,
    rollNo: student.rollNo,
    name: studentName,
    studentId: student.studentId,
  };
}

export const listTests = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const student = await getStudentForRequest(req);

    const tests = await academicDb().taskTest.findMany({
      where: {
        divisionId: student.divisionId,
        institutionId: student.institutionId,
        status: { in: ["ACTIVE", "COMPLETED"] },
      },
      select: {
        id: true, title: true, description: true, status: true,
        durationMinutes: true, totalMarks: true, numberOfQuestions: true,
        maxAttempts: true, startDate: true, validUntil: true,
        subject: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const testIds = tests.map((t) => t.id);
    const attempts = testIds.length > 0
      ? await academicDb().taskTestAttempt.findMany({
          where: { testId: { in: testIds }, studentId: student.id },
          select: { id: true, testId: true, status: true, totalScore: true, attemptNumber: true, startTime: true, endTime: true, malpracticeFlag: true },
          orderBy: { attemptNumber: "desc" },
        })
      : [];

    const now = new Date();
    const data = tests.map((t) => {
      const testAttempts = attempts.filter((a) => a.testId === t.id);
      const completed = testAttempts.filter((a) => a.status === "completed");
      const attemptsUsed = completed.length;
      const bestScore = completed.length > 0 ? Math.max(...completed.map((a) => a.totalScore)) : null;
      const bestPercentage = bestScore !== null && t.totalMarks > 0
        ? Math.round((bestScore / t.totalMarks) * 100)
        : null;

      // The most recent completed attempt for deep-linking to result
      const lastCompletedAttempt = testAttempts.find((a) => a.status === "completed");

      // All completed attempts (ascending) so the card can offer left/right
      // navigation between attempt results without a round trip to the result
      // page first — mirrors the result page's own attempt list.
      const completedAttemptsAsc = completed
        .slice()
        .sort((a, b) => a.attemptNumber - b.attemptNumber)
        .map((a) => ({
          id: a.id,
          attemptNumber: a.attemptNumber,
          totalScore: a.totalScore,
          maxScore: t.totalMarks,
          percentage: t.totalMarks > 0 ? Math.round((a.totalScore / t.totalMarks) * 100) : 0,
          startTime: a.startTime,
          endTime: a.endTime,
          malpracticeFlag: a.malpracticeFlag,
        }));

      const isExpired = (t.status === "COMPLETED") || (t.validUntil !== null && t.validUntil < now);
      const isStarted = !t.startDate || t.startDate <= now;

      let studentStatus: "LIVE" | "UPCOMING" | "DONE";
      if (attemptsUsed >= t.maxAttempts || (isExpired && attemptsUsed > 0)) {
        studentStatus = "DONE";
      } else if (isExpired) {
        // Expired with zero attempts → DONE (missed)
        studentStatus = "DONE";
      } else if (!isStarted) {
        studentStatus = "UPCOMING";
      } else {
        studentStatus = "LIVE";
      }

      // Compute days until validUntil (positive = days left, negative = overdue)
      let daysLeft: number | null = null;
      if (t.validUntil) {
        const diffMs = t.validUntil.getTime() - now.getTime();
        daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      }

      return {
        id: t.id,
        title: t.title,
        description: t.description,
        subjectName: t.subject.name,
        durationMinutes: t.durationMinutes,
        totalMarks: t.totalMarks,
        numberOfQuestions: t.numberOfQuestions,
        maxAttempts: t.maxAttempts,
        startDate: t.startDate,
        validUntil: t.validUntil,
        daysLeft,
        studentStatus,
        attemptsUsed,
        bestScore,
        bestPercentage,
        lastAttemptId: lastCompletedAttempt?.id ?? null,
        lastAttemptStartTime: lastCompletedAttempt?.startTime ?? null,
        lastAttemptEndTime: lastCompletedAttempt?.endTime ?? null,
        lastAttemptMalpracticeFlag: lastCompletedAttempt?.malpracticeFlag ?? false,
        attempts: completedAttemptsAsc,
      };
    });

    res.json({ success: true, data });
  } catch (err) { next(err); }
};

export const startTest = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const student = await getStudentForRequest(req);
    const testId = req.params.id as string;

    const test = await academicDb().taskTest.findFirst({
      where: { id: testId, divisionId: student.divisionId, institutionId: student.institutionId },
      include: {
        subject: { select: { name: true } },
        questions: {
          include: {
            question: {
              select: { id: true, type: true, question: true, questionTemplate: true, options: true, answer: true, details: true, images: true },
            },
          },
        },
      },
    });
    if (!test) throw new NotFoundError("Test not found");
    if (test.status !== "ACTIVE") throw new BadRequestError("This test is not active");

    const now = new Date();
    if (test.startDate && test.startDate > now) throw new BadRequestError("This test has not started yet");
    if (test.validUntil && test.validUntil < now) throw new BadRequestError("This test has expired");

    // Resume an already-running attempt instead of closing it out and starting a
    // fresh one. A second /start call for the same student+test (double click,
    // refreshed page, a slow network making the app retry) used to be treated as
    // "the first attempt was abandoned" and silently marked it "completed" with
    // whatever score could be computed from it (usually 0, since the student
    // hadn't answered anything yet) - that's what caused tests to show up as
    // already "submitted, 0 score" without the student actually taking them.
    // Resuming hands back the same attempt, same questions, same original timer,
    // so calling /start again is safe.
    const existing = await academicDb().taskTestAttempt.findFirst({
      where: { testId: test.id, studentId: student.id, status: "in_progress" },
    });
    if (existing) {
      const existingAnswers = await academicDb().taskStudentAnswer.findMany({
        where: { attemptId: existing.id },
        include: { question: { select: { type: true, images: true } } },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      });
      if (existingAnswers.length > 0) {
        // Section info isn't stored on TaskStudentAnswer, so it's looked up
        // from the test's own question list + sections JSON at resume time.
        const sectionsMeta = parseSections(test.sections);
        const sectionByQuestionId = new Map(test.questions.map((tq) => [tq.questionId, tq.sectionId]));
        res.json({
          success: true,
          data: {
            attemptId: existing.id,
            attemptNumber: existing.attemptNumber,
            testTitle: test.title,
            subjectName: test.subject.name,
            durationMinutes: test.durationMinutes,
            totalMarks: test.totalMarks,
            startTime: existing.startTime,
            questions: existingAnswers.map((a) => {
              const sectionId = sectionByQuestionId.get(a.questionId) ?? null;
              const section = sectionId ? sectionsMeta.find((s) => s.id === sectionId) : undefined;
              return {
                questionId: a.questionId,
                questionText: a.generatedQuestion,
                options: (a.generatedOptions as string[] | null) ?? [],
                type: a.question.type,
                sectionId,
                sectionTitle: section?.title ?? null,
                sectionInstruction: section?.instruction ?? null,
                images: a.question.images,
              };
            }),
          },
        });
        return;
      }
      // Extremely rare: an in-progress attempt exists but its question rows never
      // finished writing (e.g. the server crashed mid-request right after creating
      // the attempt row). Nothing to resume - discard it and fall through to start
      // a clean new attempt below.
      await academicDb().taskTestAttempt.delete({ where: { id: existing.id } });
    }

    const completedAttempts = await academicDb().taskTestAttempt.count({
      where: { testId: test.id, studentId: student.id, status: "completed" },
    });
    if (completedAttempts >= test.maxAttempts) throw new BadRequestError("Maximum attempts reached for this test");

    const rng = seededRng(student.rollNo + test.id + Date.now().toString());
    const selected = selectSectionAwareQuestions(test.questions, test.sections, test.numberOfQuestions, rng);
    const sectionsMeta = parseSections(test.sections);

    const attemptNumber = completedAttempts + 1;
    const attempt = await academicDb().taskTestAttempt.create({
      data: {
        testId: test.id,
        studentId: student.id,
        studentName: student.name,
        rollNo: student.rollNo,
        attemptNumber,
        maxScore: test.totalMarks,
        status: "in_progress",
      },
    });

    const personalised = selected.map((tq) => {
      const q = tq.question;
      const gen = personaliseQuestion(q, student.rollNo);
      const section = tq.sectionId ? sectionsMeta.find((s) => s.id === tq.sectionId) : undefined;
      return {
        questionId: q.id,
        questionText: gen.questionText,
        options: gen.options,
        correctAnswer: gen.correctAnswer,
        type: q.type,
        sectionId: tq.sectionId,
        sectionTitle: section?.title ?? null,
        sectionInstruction: section?.instruction ?? null,
        images: q.images as string[] | null,
      };
    });
    // Shuffle within each section (keeps the anti-cheat per-student
    // randomization) but keep sections themselves in the order the teacher
    // defined them, so the student sees "Section A" fully before "Section B"
    // instead of questions from different sections interleaved randomly.
    // Ungrouped questions (simple tests with no sections) are shuffled and
    // appended at the end.
    const orderSeed = seededRng(student.rollNo + test.id);
    const sectionOrder = sectionsMeta.map((s) => s.id);
    const bySection = new Map<string, typeof personalised>();
    const ungroupedQ: typeof personalised = [];
    for (const q of personalised) {
      if (q.sectionId) {
        if (!bySection.has(q.sectionId)) bySection.set(q.sectionId, []);
        bySection.get(q.sectionId)!.push(q);
      } else {
        ungroupedQ.push(q);
      }
    }
    const orderedSectionIds = [
      ...sectionOrder.filter((id) => bySection.has(id)),
      ...[...bySection.keys()].filter((id) => !sectionOrder.includes(id)),
    ];
    const orderedQ = [
      ...orderedSectionIds.flatMap((id) => shuffleArray(bySection.get(id)!, orderSeed)),
      ...shuffleArray(ungroupedQ, orderSeed),
    ];

    // Created (and awaited) before responding, not deferred, so the resume check
    // above never finds an in-progress attempt with zero question rows attached.
    await academicDb().taskStudentAnswer.createMany({
      data: orderedQ.map((q, i) => ({
        attemptId: attempt.id,
        questionId: q.questionId,
        generatedQuestion: q.questionText,
        ...(q.options.length > 0 ? { generatedOptions: JSON.parse(JSON.stringify(q.options)) } : {}),
        correctAnswer: q.correctAnswer,
        isCorrect: false,
        order: i,
      })),
      skipDuplicates: true,
    });

    res.json({
      success: true,
      data: {
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        testTitle: test.title,
        subjectName: test.subject.name,
        durationMinutes: test.durationMinutes,
        totalMarks: test.totalMarks,
        startTime: attempt.startTime,
        questions: orderedQ.map((q) => ({
          questionId: q.questionId,
          questionText: q.questionText,
          options: q.options,
          type: q.type,
          sectionId: q.sectionId,
          sectionTitle: q.sectionTitle,
          sectionInstruction: q.sectionInstruction,
          images: q.images,
        })),
      },
    });
  } catch (err) { next(err); }
};

export const submitTest = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const student = await getStudentForRequest(req);
    const testId = req.params.id as string;
    const { attemptId, answers, tabChangeCount } = submitTestSchema.parse(req.body);

    const test = await academicDb().taskTest.findFirst({
      where: { id: testId, divisionId: student.divisionId, institutionId: student.institutionId },
    });
    if (!test) throw new NotFoundError("Test not found");

    const attempt = await academicDb().taskTestAttempt.findFirst({
      where: { id: attemptId, testId: test.id, studentId: student.id, status: "in_progress" },
    });
    if (!attempt) throw new NotFoundError("Attempt not found or already submitted");

    const storedAnswers = await academicDb().taskStudentAnswer.findMany({ where: { attemptId } });
    const scorePerQuestion = storedAnswers.length > 0 ? test.totalMarks / storedAnswers.length : 0;
    let totalScore = 0;
    const updates: Array<{ id: string; studentAnswer: string; isCorrect: boolean }> = [];

    for (const submitted of answers) {
      const stored = storedAnswers.find((sa) => sa.questionId === submitted.questionId);
      if (!stored) continue;
      const isCorrect = (submitted.answer ?? "").trim().toLowerCase() === stored.correctAnswer.trim().toLowerCase();
      if (isCorrect) totalScore += scorePerQuestion;
      updates.push({ id: stored.id, studentAnswer: submitted.answer ?? "", isCorrect });
    }

    const roundedTotalScore = Math.round(totalScore);
    // Malpractice flag: 2 or more tab changes = flagged
    const malpracticeFlag = (tabChangeCount ?? 0) >= 2;

    await academicDb().$transaction([
      ...updates.map((u) =>
        academicDb().taskStudentAnswer.update({
          where: { id: u.id },
          data: { studentAnswer: u.studentAnswer, isCorrect: u.isCorrect },
        })
      ),
      academicDb().taskTestAttempt.update({
        where: { id: attemptId },
        data: { status: "completed", endTime: new Date(), totalScore: roundedTotalScore, tabChangeCount: tabChangeCount ?? 0, malpracticeFlag },
      }),
    ]);

    const maxScore = attempt.maxScore;
    const percentage = maxScore > 0 ? Math.round((roundedTotalScore / maxScore) * 100) : 0;

    res.json({
      success: true,
      data: {
        attemptId,
        totalScore: roundedTotalScore,
        maxScore,
        percentage,
        correct: updates.filter((u) => u.isCorrect).length,
        total: storedAnswers.length,
        malpracticeFlag,
      },
    });
  } catch (err) { next(err); }
};

export const getAttempt = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const student = await getStudentForRequest(req);
    const id = req.params.id as string;

    const attempt = await academicDb().taskTestAttempt.findUnique({
      where: { id },
      include: {
        test: {
          select: {
            title: true, totalMarks: true, sections: true, durationMinutes: true, maxAttempts: true,
            questions: { select: { questionId: true, sectionId: true } },
            subject: { select: { name: true } },
            division: { select: { name: true } },
          },
        },
        answers: {
          select: {
            questionId: true, generatedQuestion: true, generatedOptions: true,
            studentAnswer: true, correctAnswer: true, isCorrect: true,
            question: { select: { images: true } },
          },
          orderBy: { order: "asc" },
        },
      },
    });
    if (!attempt || attempt.studentId !== student.id) throw new NotFoundError("Attempt not found");
    if (attempt.status !== "completed") throw new BadRequestError("Attempt is not yet submitted");

    const percentage = attempt.maxScore > 0 ? Math.round((attempt.totalScore / attempt.maxScore) * 100) : 0;

    // All of this student's completed attempts on the same test, so the result
    // page can offer left/right navigation between attempt 1, attempt 2, etc.
    // instead of only ever being reachable one attempt at a time.
    const siblingAttempts = await academicDb().taskTestAttempt.findMany({
      where: { testId: attempt.testId, studentId: student.id, status: "completed" },
      select: { id: true, attemptNumber: true, totalScore: true, maxScore: true },
      orderBy: { attemptNumber: "asc" },
    });

    // Section info isn't stored on TaskStudentAnswer - looked up from the
    // test's own question list + sections JSON, same as on resume.
    const sectionsMeta = parseSections(attempt.test.sections);
    const sectionByQuestionId = new Map(attempt.test.questions.map((tq) => [tq.questionId, tq.sectionId]));
    const answersWithSections = attempt.answers.map((a) => {
      const sectionId = sectionByQuestionId.get(a.questionId) ?? null;
      const section = sectionId ? sectionsMeta.find((s) => s.id === sectionId) : undefined;
      const { question, ...rest } = a;
      return {
        ...rest,
        sectionId,
        sectionTitle: section?.title ?? null,
        sectionInstruction: section?.instruction ?? null,
        images: question.images as string[] | null,
      };
    });

    res.json({
      success: true,
      data: {
        id: attempt.id,
        status: attempt.status,
        totalScore: attempt.totalScore,
        maxScore: attempt.maxScore,
        percentage,
        malpracticeFlag: attempt.malpracticeFlag,
        tabChangeCount: attempt.tabChangeCount,
        attemptNumber: attempt.attemptNumber,
        startTime: attempt.startTime,
        endTime: attempt.endTime,
        student: {
          name: student.name,
          rollNo: student.rollNo,
          studentId: student.studentId,
          className: `Class ${attempt.test.division.name}`,
        },
        test: {
          title: attempt.test.title, totalMarks: attempt.test.totalMarks, durationMinutes: attempt.test.durationMinutes,
          maxAttempts: attempt.test.maxAttempts, subjectName: attempt.test.subject.name,
        },
        attempts: siblingAttempts.map((s) => ({
          id: s.id,
          attemptNumber: s.attemptNumber,
          totalScore: s.totalScore,
          maxScore: s.maxScore,
          percentage: s.maxScore > 0 ? Math.round((s.totalScore / s.maxScore) * 100) : 0,
        })),
        answers: answersWithSections,
      },
    });
  } catch (err) { next(err); }
};

// ── GET /student/tasks/attempts/:id/pdf — download own result as a PDF ────────
// Same generator/layout the teacher's per-student download icon uses (see
// downloadAttemptPdfForTeacher in teacher/tasks.controller.ts) — it's just a
// static snapshot of one attempt, so there's no reason for the two to differ.
export const downloadAttemptPdf = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const student = await getStudentForRequest(req);
    const id = req.params.id as string;

    const attempt = await academicDb().taskTestAttempt.findUnique({
      where: { id },
      include: {
        test: {
          select: {
            title: true, sections: true, durationMinutes: true, maxAttempts: true,
            questions: { select: { questionId: true, sectionId: true } },
            subject: { select: { name: true } },
            division: { select: { name: true } },
          },
        },
        answers: {
          select: {
            questionId: true, generatedQuestion: true, generatedOptions: true,
            studentAnswer: true, correctAnswer: true, isCorrect: true,
            question: { select: { images: true } },
          },
          orderBy: { order: "asc" },
        },
      },
    });
    if (!attempt || attempt.studentId !== student.id) throw new NotFoundError("Attempt not found");
    if (attempt.status !== "completed") throw new BadRequestError("Attempt is not yet submitted");

    const percentage = attempt.maxScore > 0 ? Math.round((attempt.totalScore / attempt.maxScore) * 100) : 0;
    const sectionsMeta = parseSections(attempt.test.sections);
    const sectionByQuestionId = new Map(attempt.test.questions.map((tq) => [tq.questionId, tq.sectionId]));
    const answersWithSections = attempt.answers.map((a) => {
      const { question, ...rest } = a;
      const sectionId = sectionByQuestionId.get(a.questionId) ?? null;
      const section = sectionId ? sectionsMeta.find((s) => s.id === sectionId) : undefined;
      return {
        ...rest,
        generatedOptions: Array.isArray(a.generatedOptions) ? (a.generatedOptions as string[]) : null,
        images: question.images as string[] | null,
        sectionTitle: section?.title ?? null,
        sectionInstruction: section?.instruction ?? null,
      };
    });

    const pdfBuffer = await generateTestResultPdf({
      studentName: student.name,
      rollNo: student.rollNo,
      studentBusinessId: student.studentId,
      className: `Class ${attempt.test.division.name}`,
      subjectName: attempt.test.subject.name,
      testTitle: attempt.test.title,
      totalScore: attempt.totalScore,
      maxScore: attempt.maxScore,
      percentage,
      malpracticeFlag: attempt.malpracticeFlag,
      tabChangeCount: attempt.tabChangeCount,
      attemptNumber: attempt.attemptNumber,
      maxAttempts: attempt.test.maxAttempts,
      durationMinutes: attempt.test.durationMinutes,
      startTime: attempt.startTime,
      endTime: attempt.endTime,
      questionCount: attempt.answers.length,
      answers: answersWithSections,
    });

    const safeName = student.name.replace(/[^a-z0-9]+/gi, "_");
    const safeTitle = attempt.test.title.replace(/[^a-z0-9]+/gi, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Result_${safeName}_${safeTitle}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { next(err); }
};

// ── Assignments (Student) ─────────────────────────────────────────────────────

export const listAssignments = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const student = await getStudentForRequest(req);

    const assignments = await academicDb().taskAssignment.findMany({
      where: {
        divisionId: student.divisionId,
        institutionId: student.institutionId,
        status: { in: ["ACTIVE", "COMPLETED"] },
      },
      select: {
        id: true, title: true, description: true, status: true,
        totalMarks: true, dueDate: true, submissionType: true,
        subject: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    if (assignments.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const assignmentIds = assignments.map((a) => a.id);
    const submissions = await academicDb().taskAssignmentSubmission.findMany({
      where: { assignmentId: { in: assignmentIds }, studentId: student.id },
    });
    const subMap = new Map(submissions.map((s) => [s.assignmentId, s]));

    // Full submission history (newest first), grouped by assignment — so a
    // resubmission shows the earlier PDF instead of losing it.
    const attempts = await academicDb().taskAssignmentSubmissionAttempt.findMany({
      where: { assignmentId: { in: assignmentIds }, studentId: student.id },
      orderBy: { attemptNumber: "desc" },
    });
    const attemptsMap = new Map<string, typeof attempts>();
    for (const a of attempts) {
      const list = attemptsMap.get(a.assignmentId) ?? [];
      list.push(a);
      attemptsMap.set(a.assignmentId, list);
    }

    const now = new Date();
    const data = assignments.map((a) => {
      const sub = subMap.get(a.id) ?? null;

      let studentStatus: "PENDING" | "SUBMITTED" | "WRITE_AGAIN" | "CORRECT" | "MISSED" | "OVERDUE";

      if (a.submissionType === "OFFLINE") {
        // OFFLINE — deliberately simpler than ONLINE: neither the due date
        // nor stopping the assignment (Stop Now) ever auto-flips this to
        // MISSED. It's just PENDING until the teacher marks it received
        // (SUBMITTED) — full stop. "Late" is a separate manual flag
        // (offlineMarkedLate) the teacher can toggle, only shown alongside
        // SUBMITTED, never auto-derived.
        if (sub?.offlineSubmittedAt) {
          studentStatus = "SUBMITTED";
        } else {
          studentStatus = "PENDING";
        }
      } else {
        // ONLINE — the submit link stays open past the due date, so an
        // unsubmitted assignment stays PENDING the whole time it's ACTIVE
        // (that keeps the submit button visible). It only becomes MISSED
        // once the teacher explicitly stops the assignment (status flips to
        // COMPLETED) and the student never submitted anything.
        if (sub?.reviewStatus === "CORRECT") {
          studentStatus = "CORRECT";
        } else if (sub?.reviewStatus === "WRITE_AGAIN") {
          studentStatus = "WRITE_AGAIN";
        } else if (sub?.submittedAt) {
          studentStatus = "SUBMITTED";
        } else if (a.status !== "ACTIVE") {
          studentStatus = "MISSED";
        } else {
          studentStatus = "PENDING";
        }
      }

      // Only meaningful for ONLINE — flags that the current submission landed
      // after the due date so the UI can show a "Late" tag once it's approved,
      // without disturbing the PENDING → SUBMITTED → WRITE_AGAIN/CORRECT flow.
      const lateSubmission =
        a.submissionType === "ONLINE" && !!sub?.submittedAt && a.dueDate !== null && sub.submittedAt > a.dueDate;

      let daysLeft: number | null = null;
      if (a.dueDate) {
        const diffMs = a.dueDate.getTime() - now.getTime();
        daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      }

      return {
        id: a.id,
        title: a.title,
        description: a.description,
        subjectName: a.subject.name,
        totalMarks: a.totalMarks,
        dueDate: a.dueDate,
        daysLeft,
        submissionType: a.submissionType,
        studentStatus,
        lateSubmission,
        submission: sub ? {
          id: sub.id,
          fileUrl: sub.fileUrl,
          submittedAt: sub.submittedAt,
          resubmitCount: sub.resubmitCount,
          reviewStatus: sub.reviewStatus,
          reviewNote: sub.reviewNote,
          reviewedAt: sub.reviewedAt,
          offlineSubmittedAt: sub.offlineSubmittedAt,
          offlineMarkedLate: sub.offlineMarkedLate,
        } : null,
        // Newest first — attempts[0] is the same upload mirrored on `submission`.
        attempts: (attemptsMap.get(a.id) ?? []).map((at) => ({
          id: at.id,
          attemptNumber: at.attemptNumber,
          fileUrl: at.fileUrl,
          submittedAt: at.submittedAt,
          reviewStatus: at.reviewStatus,
          reviewNote: at.reviewNote,
          reviewedAt: at.reviewedAt,
        })),
      };
    });

    res.json({ success: true, data });
  } catch (err) { next(err); }
};

export const submitAssignment = async (
  req: AuthRequest & { file?: Express.Multer.File },
  res: Response,
  next: NextFunction
) => {
  try {
    const student = await getStudentForRequest(req);
    const assignmentId = req.params.id as string;

    const assignment = await academicDb().taskAssignment.findFirst({
      where: {
        id: assignmentId,
        divisionId: student.divisionId,
        institutionId: student.institutionId,
        status: "ACTIVE",
      },
    });
    if (!assignment) throw new NotFoundError("Assignment not found or not active");
    if (assignment.submissionType !== "ONLINE") {
      throw new BadRequestError("This assignment requires offline submission only");
    }

    // Submissions stay open past the due date — the assignment just gets
    // flagged as a late submission (see studentStatus/lateSubmission below)
    // instead of blocking the student from uploading at all.

    if (!req.file) throw new BadRequestError("PDF file is required");

    // Check if existing submission is in WRITE_AGAIN state or no submission yet
    const existing = await academicDb().taskAssignmentSubmission.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId: student.id } },
    });

    if (existing?.reviewStatus === "CORRECT") {
      throw new BadRequestError("This assignment has already been marked as correct");
    }

    // Upload to R2
    const { publicUrl, path: fileKey } = await uploadAttachmentToR2(req.file.buffer, {
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      institutionId: student.institutionId,
      area: `assignments/${assignmentId}`,
    });

    const resubmitCount = existing ? existing.resubmitCount + (existing.submittedAt ? 1 : 0) : 0;
    const now = new Date();

    // TaskAssignmentSubmission stays the "current state" pointer (what every
    // existing status read already joins against) — always overwritten with
    // the latest upload. The full history lives in TaskAssignmentSubmissionAttempt,
    // one row per upload, so a resubmission never erases the previous version.
    const submission = await academicDb().taskAssignmentSubmission.upsert({
      where: { assignmentId_studentId: { assignmentId, studentId: student.id } },
      create: {
        assignmentId,
        studentId: student.id,
        institutionId: student.institutionId,
        fileKey,
        fileUrl: publicUrl,
        submittedAt: now,
        resubmitCount: 0,
        reviewStatus: null,
      },
      update: {
        fileKey,
        fileUrl: publicUrl,
        submittedAt: now,
        resubmitCount,
        reviewStatus: null,
        reviewNote: null,
        reviewedAt: null,
        reviewedByTeacherId: null,
      },
    });

    // attemptNumber is always derived from the highest number already stored
    // for this submission (not a separately-tracked counter) so it can never
    // collide, even if older rows are inconsistent for any reason.
    const currentMax = async () => {
      const agg = await academicDb().taskAssignmentSubmissionAttempt.aggregate({
        where: { submissionId: submission.id },
        _max: { attemptNumber: true },
      });
      return agg._max.attemptNumber ?? 0;
    };

    // Backfill: if this submission predates the attempt-history feature (has
    // an old upload but zero attempt rows yet), preserve that old upload as
    // attempt #1 before recording the new one — otherwise it'd be lost the
    // moment the upsert above overwrote fileUrl/submittedAt on the pointer row.
    if (existing?.submittedAt && (await currentMax()) === 0) {
      await academicDb().taskAssignmentSubmissionAttempt.create({
        data: {
          submissionId: submission.id,
          assignmentId,
          studentId: student.id,
          institutionId: student.institutionId,
          attemptNumber: 1,
          fileKey: existing.fileKey,
          fileUrl: existing.fileUrl,
          submittedAt: existing.submittedAt,
          reviewStatus: existing.reviewStatus,
          reviewNote: existing.reviewNote,
          reviewedAt: existing.reviewedAt,
          reviewedByTeacherId: existing.reviewedByTeacherId,
        },
      });
    }

    await academicDb().taskAssignmentSubmissionAttempt.create({
      data: {
        submissionId: submission.id,
        assignmentId,
        studentId: student.id,
        institutionId: student.institutionId,
        attemptNumber: (await currentMax()) + 1,
        fileKey,
        fileUrl: publicUrl,
        submittedAt: now,
      },
    });

    res.json({ success: true, data: submission });
  } catch (err) { next(err); }
};

export const getOwnSubmission = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const student = await getStudentForRequest(req);
    const assignmentId = req.params.id as string;

    const assignment = await academicDb().taskAssignment.findFirst({
      where: { id: assignmentId, divisionId: student.divisionId, institutionId: student.institutionId },
      select: { id: true, title: true, submissionType: true },
    });
    if (!assignment) throw new NotFoundError("Assignment not found");

    const submission = await academicDb().taskAssignmentSubmission.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId: student.id } },
    });

    res.json({ success: true, data: submission ?? null });
  } catch (err) { next(err); }
};

// ── Assignment Paper (View + Download) ─────────────────────────────────────
// The paper builder lets a teacher attach an actual question paper (sections
// + questions) to an assignment, same as a test — but until now students
// never saw it, only the submission-tracking UI. This assembles that paper
// exactly as built, personalised per-student the same way a test's questions
// already are (seededRng(rollNo + questionId) — NUMERICAL gets real computed
// values instead of the raw {variable} template, CONCEPTUAL/MCQ options are
// shuffled so the correct answer's position isn't always first/static). The
// correct answer itself is never included in the response.
type StoredAssignmentQ = { questionId: string; sectionId: string | null; marks: number; order: number; isCompulsory: boolean };

async function buildAssignmentPaperView(req: AuthRequest) {
  const student = await getStudentForRequest(req);
  const assignmentId = req.params.id as string;

  const assignment = await academicDb().taskAssignment.findFirst({
    where: {
      id: assignmentId,
      divisionId: student.divisionId,
      institutionId: student.institutionId,
      status: { in: ["ACTIVE", "COMPLETED"] },
    },
    select: {
      id: true, title: true, description: true, totalMarks: true, dueDate: true,
      submissionType: true, answerSpace: true, isRandomized: true, sections: true, questions: true,
      subject: { select: { name: true } },
      division: { select: { name: true } },
    },
  });
  if (!assignment) throw new NotFoundError("Assignment not found");

  const storedQs = (assignment.questions as StoredAssignmentQ[] | null) ?? [];
  const questionIds = storedQs.map((q) => q.questionId);

  const questionObjects = questionIds.length > 0
    ? await academicDb().taskQuestion.findMany({
        where: { id: { in: questionIds }, institutionId: student.institutionId },
        select: { id: true, type: true, question: true, questionTemplate: true, options: true, answer: true, details: true, images: true },
      })
    : [];
  const qMap = new Map(questionObjects.map((q) => [q.id, q]));

  const questions = storedQs
    .map((sq) => {
      const q = qMap.get(sq.questionId);
      if (!q) return null;
      const generated = personaliseQuestion(q, student.rollNo);
      const options = q.type === "TRUE_FALSE" ? ["True", "False"] : generated.options;
      return {
        id: q.id,
        type: q.type,
        question: generated.questionText,
        options,
        sectionId: sq.sectionId,
        marks: sq.marks,
        order: sq.order,
        images: q.images as string[] | null,
      };
    })
    .filter((q): q is NonNullable<typeof q> => q !== null)
    .sort((a, b) => a.order - b.order);

  // Same letterhead the teacher's paper builder prints on an assignment
  // paper (GET /teacher/institution/letterhead) — fetched here too so the
  // student's read-only view/PDF matches it exactly, not just the layout.
  const institution = await prisma.institution.findUnique({
    where: { id: student.institutionId },
    select: { name: true, logoUrl: true, address: true, city: true, state: true, pincode: true },
  });

  return {
    assignment: {
      id: assignment.id,
      title: assignment.title,
      description: assignment.description,
      subjectName: assignment.subject.name,
      className: assignment.division.name,
      totalMarks: assignment.totalMarks,
      dueDate: assignment.dueDate,
      submissionType: assignment.submissionType,
      answerSpace: assignment.answerSpace,
      isRandomized: assignment.isRandomized,
      sections: parseSections(assignment.sections),
    },
    questions,
    student: { name: student.name, rollNo: student.rollNo, studentId: student.studentId },
    institution,
  };
}

// ── GET /student/tasks/assignments/:id/paper — view the built paper ────────
export const getAssignmentPaper = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const view = await buildAssignmentPaperView(req);
    res.json({ success: true, data: view });
  } catch (err) { next(err); }
};

// ── GET /student/tasks/assignments/:id/paper/pdf — download the paper as PDF ──
export const downloadAssignmentPaperPdf = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const view = await buildAssignmentPaperView(req);
    const buffer = await generateAssignmentPaperPdf(view);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${view.assignment.title.replace(/\s+/g, "_")}.pdf"`);
    res.send(buffer);
  } catch (err) { next(err); }
};
