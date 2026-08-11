// src/modules/student/tasks.controller.ts
import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
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
): Promise<{ id: string; institutionId: string; divisionId: string; rollNo: string; name: string }> {
  const { userId, institutionId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  const student = await prisma.student.findFirst({
    where: { userId, institutionId },
    select: { id: true, divisionId: true, rollNo: true, user: { select: { name: true } } },
  });
  if (!student) throw new NotFoundError("Student profile not found");
  if (!student.divisionId) throw new BadRequestError("You are not assigned to a division yet");
  if (!student.rollNo) throw new BadRequestError("Your roll number is not set — contact your teacher");
  if (!student.user?.name) throw new BadRequestError("Your name is not set — contact your teacher");

  return {
    id: student.id,
    institutionId,
    divisionId: student.divisionId,
    rollNo: student.rollNo,
    name: student.user.name,
  };
}

export const listTests = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const student = await getStudentForRequest(req);

    const tests = await prisma.taskTest.findMany({
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
      ? await prisma.taskTestAttempt.findMany({
          where: { testId: { in: testIds }, studentId: student.id },
          select: { id: true, testId: true, status: true, totalScore: true, attemptNumber: true, endTime: true },
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
        lastAttemptEndTime: lastCompletedAttempt?.endTime ?? null,
      };
    });

    res.json({ success: true, data });
  } catch (err) { next(err); }
};

export const startTest = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const student = await getStudentForRequest(req);
    const testId = req.params.id as string;

    const test = await prisma.taskTest.findFirst({
      where: { id: testId, divisionId: student.divisionId, institutionId: student.institutionId },
      include: {
        subject: { select: { name: true } },
        questions: {
          include: {
            question: {
              select: { id: true, type: true, question: true, questionTemplate: true, options: true, answer: true, details: true },
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
    const existing = await prisma.taskTestAttempt.findFirst({
      where: { testId: test.id, studentId: student.id, status: "in_progress" },
    });
    if (existing) {
      const existingAnswers = await prisma.taskStudentAnswer.findMany({
        where: { attemptId: existing.id },
        include: { question: { select: { type: true } } },
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
      await prisma.taskTestAttempt.delete({ where: { id: existing.id } });
    }

    const completedAttempts = await prisma.taskTestAttempt.count({
      where: { testId: test.id, studentId: student.id, status: "completed" },
    });
    if (completedAttempts >= test.maxAttempts) throw new BadRequestError("Maximum attempts reached for this test");

    const rng = seededRng(student.rollNo + test.id + Date.now().toString());
    const selected = selectSectionAwareQuestions(test.questions, test.sections, test.numberOfQuestions, rng);
    const sectionsMeta = parseSections(test.sections);

    const attemptNumber = completedAttempts + 1;
    const attempt = await prisma.taskTestAttempt.create({
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
    await prisma.taskStudentAnswer.createMany({
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

    const test = await prisma.taskTest.findFirst({
      where: { id: testId, divisionId: student.divisionId, institutionId: student.institutionId },
    });
    if (!test) throw new NotFoundError("Test not found");

    const attempt = await prisma.taskTestAttempt.findFirst({
      where: { id: attemptId, testId: test.id, studentId: student.id, status: "in_progress" },
    });
    if (!attempt) throw new NotFoundError("Attempt not found or already submitted");

    const storedAnswers = await prisma.taskStudentAnswer.findMany({ where: { attemptId } });
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

    await prisma.$transaction([
      ...updates.map((u) =>
        prisma.taskStudentAnswer.update({
          where: { id: u.id },
          data: { studentAnswer: u.studentAnswer, isCorrect: u.isCorrect },
        })
      ),
      prisma.taskTestAttempt.update({
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

    const attempt = await prisma.taskTestAttempt.findUnique({
      where: { id },
      include: {
        test: {
          select: {
            title: true, totalMarks: true, sections: true, durationMinutes: true, maxAttempts: true,
            questions: { select: { questionId: true, sectionId: true } },
          },
        },
        answers: {
          select: {
            questionId: true, generatedQuestion: true, generatedOptions: true,
            studentAnswer: true, correctAnswer: true, isCorrect: true,
          },
          orderBy: { order: "asc" },
        },
      },
    });
    if (!attempt || attempt.studentId !== student.id) throw new NotFoundError("Attempt not found");
    if (attempt.status !== "completed") throw new BadRequestError("Attempt is not yet submitted");

    const percentage = attempt.maxScore > 0 ? Math.round((attempt.totalScore / attempt.maxScore) * 100) : 0;

    // Section info isn't stored on TaskStudentAnswer - looked up from the
    // test's own question list + sections JSON, same as on resume.
    const sectionsMeta = parseSections(attempt.test.sections);
    const sectionByQuestionId = new Map(attempt.test.questions.map((tq) => [tq.questionId, tq.sectionId]));
    const answersWithSections = attempt.answers.map((a) => {
      const sectionId = sectionByQuestionId.get(a.questionId) ?? null;
      const section = sectionId ? sectionsMeta.find((s) => s.id === sectionId) : undefined;
      return {
        ...a,
        sectionId,
        sectionTitle: section?.title ?? null,
        sectionInstruction: section?.instruction ?? null,
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
        test: { title: attempt.test.title, totalMarks: attempt.test.totalMarks, durationMinutes: attempt.test.durationMinutes, maxAttempts: attempt.test.maxAttempts },
        answers: answersWithSections,
      },
    });
  } catch (err) { next(err); }
};

// ── Assignments (Student) ─────────────────────────────────────────────────────

export const listAssignments = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const student = await getStudentForRequest(req);

    const assignments = await prisma.taskAssignment.findMany({
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
    const submissions = await prisma.taskAssignmentSubmission.findMany({
      where: { assignmentId: { in: assignmentIds }, studentId: student.id },
    });
    const subMap = new Map(submissions.map((s) => [s.assignmentId, s]));

    const now = new Date();
    const data = assignments.map((a) => {
      const sub = subMap.get(a.id) ?? null;

      let studentStatus: "PENDING" | "SUBMITTED" | "WRITE_AGAIN" | "CORRECT" | "MISSED" | "OVERDUE";
      const isOverdue = a.dueDate !== null && a.dueDate < now;

      if (a.submissionType === "OFFLINE") {
        if (sub?.offlineSubmittedAt) {
          studentStatus = "SUBMITTED";
        } else if (isOverdue) {
          studentStatus = "MISSED";
        } else {
          studentStatus = "PENDING";
        }
      } else {
        // ONLINE
        if (sub?.reviewStatus === "CORRECT") {
          studentStatus = "CORRECT";
        } else if (sub?.reviewStatus === "WRITE_AGAIN") {
          studentStatus = "WRITE_AGAIN";
        } else if (sub?.submittedAt) {
          studentStatus = "SUBMITTED";
        } else if (isOverdue) {
          studentStatus = "MISSED";
        } else {
          studentStatus = isOverdue ? "OVERDUE" : "PENDING";
        }
      }

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
        submission: sub ? {
          id: sub.id,
          fileUrl: sub.fileUrl,
          submittedAt: sub.submittedAt,
          resubmitCount: sub.resubmitCount,
          reviewStatus: sub.reviewStatus,
          reviewNote: sub.reviewNote,
          reviewedAt: sub.reviewedAt,
          offlineSubmittedAt: sub.offlineSubmittedAt,
        } : null,
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

    const assignment = await prisma.taskAssignment.findFirst({
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

    // Check due date
    if (assignment.dueDate && assignment.dueDate < new Date()) {
      throw new BadRequestError("The deadline for this assignment has passed");
    }

    if (!req.file) throw new BadRequestError("PDF file is required");

    // Check if existing submission is in WRITE_AGAIN state or no submission yet
    const existing = await prisma.taskAssignmentSubmission.findUnique({
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

    const submission = await prisma.taskAssignmentSubmission.upsert({
      where: { assignmentId_studentId: { assignmentId, studentId: student.id } },
      create: {
        assignmentId,
        studentId: student.id,
        institutionId: student.institutionId,
        fileKey,
        fileUrl: publicUrl,
        submittedAt: new Date(),
        resubmitCount: 0,
        reviewStatus: null,
      },
      update: {
        fileKey,
        fileUrl: publicUrl,
        submittedAt: new Date(),
        resubmitCount,
        reviewStatus: null,
        reviewNote: null,
        reviewedAt: null,
        reviewedByTeacherId: null,
      },
    });

    res.json({ success: true, data: submission });
  } catch (err) { next(err); }
};

export const getOwnSubmission = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const student = await getStudentForRequest(req);
    const assignmentId = req.params.id as string;

    const assignment = await prisma.taskAssignment.findFirst({
      where: { id: assignmentId, divisionId: student.divisionId, institutionId: student.institutionId },
      select: { id: true, title: true, submissionType: true },
    });
    if (!assignment) throw new NotFoundError("Assignment not found");

    const submission = await prisma.taskAssignmentSubmission.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId: student.id } },
    });

    res.json({ success: true, data: submission ?? null });
  } catch (err) { next(err); }
};
