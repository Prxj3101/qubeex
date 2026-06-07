// src/modules/teacher/tasks.controller.ts
import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import {
  generateQuestionsSchema,
  editQuestionSchema,
  createModuleSchema,
  editModuleSchema,
  assignQuestionSchema,
} from "./tasks.schema";
import { redis, isRedisReady } from "../../utils/redis";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require("pdfkit");

// ── OpenAI / Groq (same pattern as blackboard) ────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpenAIModule = (process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY) ? require("openai") : null;
const openai: import("openai").OpenAI | null = OpenAIModule
  ? new OpenAIModule.OpenAI(
      process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : { apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" }
    )
  : null;
const AI_MODEL = process.env.OPENAI_API_KEY ? "gpt-4.1-mini" : "llama-3.3-70b-versatile";

// ── Upload config ─────────────────────────────────────────────────────────────
export const taskUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // 5 MB max
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype === "application/pdf") return cb(null, true);
    cb(new BadRequestError("Only PDF files are accepted for question generation"));
  },
});

// ── Token pool (same pattern as blackboard) ───────────────────────────────────
async function checkTokenPool(institutionId: string): Promise<void> {
  if (!openai) return;
  if (!redis || !isRedisReady) {
    if (redis) console.warn("[tasks] Redis configured but not ready — token pool check skipped");
    return;
  }
  const [used, limit] = await Promise.all([
    redis.get(`ai:usage:institution:${institutionId}`),
    redis.get(`ai:limit:institution:${institutionId}`),
  ]);
  const usedN = Number(used ?? 0);
  const limitN = Number(limit ?? 0);
  if (limitN > 0 && usedN >= limitN) {
    throw Object.assign(new Error("Token limit reached"), { statusCode: 429 });
  }
}

async function deductTokens(institutionId: string, tokens: number): Promise<void> {
  if (!redis || !isRedisReady || tokens <= 0) return;
  await redis.incrby(`ai:usage:institution:${institutionId}`, tokens).catch(() => {});
}

// ── Shared helpers ────────────────────────────────────────────────────────────
const MAX_TEXT_LENGTH = 12000;

async function extractPdfText(buffer: Buffer): Promise<{ text: string; truncated: boolean }> {
  const data = await pdfParse(buffer);
  const text = (data.text as string).trim();
  if (text.length <= MAX_TEXT_LENGTH) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_LENGTH), truncated: true };
}

function requireTeacher(req: AuthRequest) {
  const { institutionId, userId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return { institutionId, userId };
}

async function getTeacherId(userId: string, institutionId: string): Promise<string> {
  const teacher = await prisma.teacher.findFirst({
    where: { userId, institutionId },
    select: { id: true },
  });
  if (!teacher) throw new BadRequestError("Teacher profile not found");
  return teacher.id;
}

// Derives subjectId from divisionId + teacherId — never trust client-supplied subjectId
async function resolveSubjectAssignment(
  teacherId: string,
  divisionId: string,
  institutionId: string
): Promise<{ subjectId: string; subjectName: string }> {
  const assignment = await prisma.divisionAssignment.findFirst({
    where: {
      teacherId,
      divisionId,
      institutionId,
      subjectId: { not: null },
    },
    select: { subjectId: true, subject: { select: { name: true } } },
  });
  if (!assignment?.subjectId || !assignment.subject)
    throw new NotFoundError("No subject assignment found for this teacher in this division");
  return { subjectId: assignment.subjectId, subjectName: assignment.subject.name };
}

const GENERATION_SYSTEM_PROMPT = `You are an expert educational question setter creating assessment questions for students.

Rules:
- Detect the language of the notes and generate ALL questions in that EXACT same language (Hindi, Marathi, English, or any other)
- For mathematics: use clear plain text notation only (e.g. "sin²θ + cos²θ = 1", "√2 ≈ 1.414", "∑n = n(n+1)/2")
- Generate a natural mix of question types proportional to the content length, maximum 30 questions total:
    MCQ — 4 options labelled as plain strings (not A/B/C/D), one correct answer
    FILL_BLANK — key term or phrase is replaced with ___
    TRUE_FALSE — a factual statement from the notes
    SHORT_ANSWER — open question requiring 1–3 sentence answer
- Base EVERY question strictly on the provided notes — no external knowledge
- If teacher instruction is provided, follow it precisely (e.g. focus on chapter 3, avoid examples, generate more MCQs)
- Do not repeat any question from the "Already Generated" list if provided

Return ONLY valid JSON — no markdown, no explanation:
{
  "questions": [
    {"type": "MCQ", "question": "...", "options": ["...", "...", "...", "..."], "answer": "..."},
    {"type": "FILL_BLANK", "question": "The ___ is the powerhouse of the cell.", "answer": "mitochondria"},
    {"type": "TRUE_FALSE", "question": "Water boils at 100°C at sea level.", "answer": "true"},
    {"type": "SHORT_ANSWER", "question": "Explain Newton's first law.", "answer": "An object at rest stays at rest and an object in motion stays in motion unless acted on by an external force."}
  ]
}`;

// ── Generate Questions ────────────────────────────────────────────────────────

export const generateQuestions = async (
  req: AuthRequest & { file?: Express.Multer.File },
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);

    if (!req.file) throw new BadRequestError("PDF file is required");

    const body = generateQuestionsSchema.parse({
      divisionId: req.body.divisionId,
      prompt: req.body.prompt,
      more: req.body.more === "true" || req.body.more === true,
    });

    const { subjectId } = await resolveSubjectAssignment(teacherId, body.divisionId, institutionId);

    // Extract text from PDF
    const { text, truncated } = await extractPdfText(req.file.buffer);
    if (!text || text.length < 50)
      throw new BadRequestError("Could not extract readable text from the PDF. Ensure the PDF contains selectable text.");

    // Build user message
    let userMessage = `Notes:\n${text}`;

    if (body.prompt?.trim()) {
      userMessage = `Teacher instruction: ${body.prompt.trim()}\n\n${userMessage}`;
    }

    // If "generate more", fetch existing questions and add as context
    if (body.more) {
      const existing = await prisma.taskQuestion.findMany({
        where: { teacherId, subjectId, institutionId },
        select: { question: true },
        take: 50,
      });
      if (existing.length > 0) {
        const existingList = existing.map((q, i) => `${i + 1}. ${q.question}`).join("\n");
        userMessage = `Already Generated (do not repeat these):\n${existingList}\n\n${userMessage}`;
      }
    }

    // Mock fallback when no AI key configured
    if (!openai) {
      const mockQuestions = [
        { type: "MCQ" as const, question: "Which of the following best describes the main topic?", options: ["Option A", "Option B", "Option C", "Option D"], answer: "Option A" },
        { type: "FILL_BLANK" as const, question: "The key concept discussed is ___.", answer: "the main topic" },
        { type: "TRUE_FALSE" as const, question: "The notes discuss an important educational concept.", answer: "true" },
        { type: "SHORT_ANSWER" as const, question: "Summarise the main idea from the notes.", answer: "The notes cover an important concept relevant to the subject." },
      ];
      const saved = await prisma.$transaction(
        mockQuestions.map(q =>
          prisma.taskQuestion.create({
            data: {
              institutionId,
              teacherId,
              subjectId,
              type: q.type,
              question: q.question,
              options: q.type === "MCQ" ? q.options : undefined,
              answer: q.answer,
            },
          })
        )
      );
      return res.status(201).json({ success: true, data: { questions: saved, truncated, mock: true } });
    }

    await checkTokenPool(institutionId);

    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: GENERATION_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.4,
    });

    await deductTokens(institutionId, completion.usage?.total_tokens ?? 0);

    let parsed: { questions: { type: string; question: string; options?: string[]; answer: string }[] };
    try {
      parsed = JSON.parse(completion.choices[0].message.content ?? "{}");
    } catch {
      throw new BadRequestError("AI returned malformed JSON — please try again");
    }

    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      throw new BadRequestError("AI returned no questions — try a more detailed prompt or a different PDF");
    }

    const VALID_TYPES = new Set(["MCQ", "FILL_BLANK", "TRUE_FALSE", "SHORT_ANSWER"]);

    const saved = await prisma.$transaction(
      parsed.questions
        .filter(q => VALID_TYPES.has(q.type) && q.question?.trim() && q.answer?.trim())
        .slice(0, 30)
        .map(q =>
          prisma.taskQuestion.create({
            data: {
              institutionId,
              teacherId,
              subjectId,
              type: q.type as "MCQ" | "FILL_BLANK" | "TRUE_FALSE" | "SHORT_ANSWER",
              question: q.question.trim(),
              options: q.type === "MCQ" && Array.isArray(q.options) ? q.options.slice(0, 4) : undefined,
              answer: q.answer.trim(),
            },
          })
        )
    );

    res.status(201).json({ success: true, data: { questions: saved, truncated } });
  } catch (err) { next(err); }
};

// ── Question Bank CRUD ────────────────────────────────────────────────────────

export const listQuestions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const divisionId = req.query.divisionId as string;

    if (!divisionId) throw new BadRequestError("divisionId query param is required");

    const { subjectId } = await resolveSubjectAssignment(teacherId, divisionId, institutionId);

    const questions = await prisma.taskQuestion.findMany({
      where: { teacherId, subjectId, institutionId },
      include: { moduleAssignment: { select: { moduleId: true, module: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: questions });
  } catch (err) { next(err); }
};

export const editQuestion = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;
    const data = editQuestionSchema.parse(req.body);

    const question = await prisma.taskQuestion.findFirst({
      where: { id, teacherId, institutionId },
    });
    if (!question) throw new NotFoundError("Question not found");

    // Validate options present for MCQ
    if (question.type === "MCQ" && (!data.options || data.options.length !== 4)) {
      throw new BadRequestError("MCQ questions require exactly 4 options");
    }
    // Validate answer is one of the options for MCQ
    if (question.type === "MCQ" && data.options && !data.options.includes(data.answer)) {
      throw new BadRequestError("Answer must be one of the provided options");
    }
    // TRUE_FALSE answer must be "true" or "false"
    if (question.type === "TRUE_FALSE" && !["true", "false"].includes(data.answer.toLowerCase())) {
      throw new BadRequestError("True/False answer must be 'true' or 'false'");
    }

    const updated = await prisma.taskQuestion.update({
      where: { id },
      data: {
        question: data.question,
        options: question.type === "MCQ" ? (data.options as string[]) : undefined,
        answer: data.answer,
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

export const deleteQuestion = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const question = await prisma.taskQuestion.findFirst({
      where: { id, teacherId, institutionId },
    });
    if (!question) throw new NotFoundError("Question not found");

    await prisma.taskQuestion.delete({ where: { id } });

    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── Export Question Bank as PDF ───────────────────────────────────────────────

export const exportQuestions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const divisionId = req.query.divisionId as string;

    if (!divisionId) throw new BadRequestError("divisionId query param is required");

    const { subjectId, subjectName } = await resolveSubjectAssignment(teacherId, divisionId, institutionId);

    const questions = await prisma.taskQuestion.findMany({
      where: { teacherId, subjectId, institutionId },
      orderBy: [{ type: "asc" }, { createdAt: "asc" }],
    });

    if (questions.length === 0) throw new BadRequestError("No questions to export");

    const teacher = await prisma.teacher.findFirst({
      where: { id: teacherId },
      select: { user: { select: { name: true } } },
    });

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${subjectName.replace(/\s+/g, "_")}_Question_Bank.pdf"`
    );
    doc.pipe(res);

    // Title
    doc.fontSize(18).font("Helvetica-Bold").text(`${subjectName} — Question Bank`, { align: "center" });
    doc.fontSize(10).font("Helvetica").fillColor("#666666")
      .text(`Teacher: ${teacher?.user?.name ?? "Unknown"}   |   Generated: ${new Date().toLocaleDateString("en-IN")}`, { align: "center" });
    doc.moveDown(1.5);

    const TYPE_LABELS: Record<string, string> = {
      MCQ: "Multiple Choice",
      FILL_BLANK: "Fill in the Blank",
      TRUE_FALSE: "True / False",
      SHORT_ANSWER: "Short Answer",
    };

    let qNumber = 1;
    for (const type of ["MCQ", "FILL_BLANK", "TRUE_FALSE", "SHORT_ANSWER"] as const) {
      const group = questions.filter(q => q.type === type);
      if (group.length === 0) continue;

      doc.fontSize(13).font("Helvetica-Bold").fillColor("#000000")
        .text(TYPE_LABELS[type], { underline: true });
      doc.moveDown(0.5);

      for (const q of group) {
        doc.fontSize(11).font("Helvetica-Bold").fillColor("#000000")
          .text(`Q${qNumber}. ${q.question}`);

        if (q.type === "MCQ" && Array.isArray(q.options)) {
          const opts = q.options as string[];
          const labels = ["a", "b", "c", "d"];
          opts.forEach((opt, i) => {
            doc.fontSize(10).font("Helvetica").fillColor("#333333")
              .text(`   ${labels[i]}) ${opt}`);
          });
        }

        doc.fontSize(9).font("Helvetica-Oblique").fillColor("#1a6b3a")
          .text(`   Answer: ${q.answer}`);
        doc.moveDown(0.7);
        qNumber++;
      }
      doc.moveDown(0.5);
    }

    doc.end();
  } catch (err) { next(err); }
};

// ── Modules (Chapters) CRUD ───────────────────────────────────────────────────

export const listModules = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const divisionId = req.query.divisionId as string;

    if (!divisionId) throw new BadRequestError("divisionId query param is required");

    const { subjectId } = await resolveSubjectAssignment(teacherId, divisionId, institutionId);

    const modules = await prisma.taskModule.findMany({
      where: { teacherId, subjectId, institutionId },
      include: {
        questions: {
          include: {
            question: {
              select: { id: true, type: true, question: true, options: true, answer: true, createdAt: true },
            },
          },
          orderBy: { assignedAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json({ success: true, data: modules });
  } catch (err) { next(err); }
};

export const createModule = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const data = createModuleSchema.parse(req.body);

    const { subjectId } = await resolveSubjectAssignment(teacherId, data.divisionId, institutionId);

    const taskModule = await prisma.taskModule.create({
      data: { institutionId, teacherId, subjectId, name: data.name, description: data.description ?? null },
      include: { questions: true },
    });

    res.status(201).json({ success: true, data: taskModule });
  } catch (err) { next(err); }
};

export const editModule = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;
    const data = editModuleSchema.parse(req.body);

    const taskModule = await prisma.taskModule.findFirst({ where: { id, teacherId, institutionId } });
    if (!taskModule) throw new NotFoundError("Module not found");

    const updated = await prisma.taskModule.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

export const deleteModule = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const taskModule = await prisma.taskModule.findFirst({ where: { id, teacherId, institutionId } });
    if (!taskModule) throw new NotFoundError("Module not found");

    // TaskModuleQuestion rows are cascade-deleted via the relation
    await prisma.taskModule.delete({ where: { id } });

    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── Module–Question Assignment ────────────────────────────────────────────────

export const assignQuestionToModule = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const moduleId = req.params.id as string;
    const { questionId } = assignQuestionSchema.parse(req.body);

    // Verify module ownership
    const taskModule = await prisma.taskModule.findFirst({ where: { id: moduleId, teacherId, institutionId } });
    if (!taskModule) throw new NotFoundError("Module not found");

    // Verify question ownership and same subject
    const question = await prisma.taskQuestion.findFirst({
      where: { id: questionId, teacherId, institutionId, subjectId: taskModule.subjectId },
    });
    if (!question) throw new NotFoundError("Question not found or belongs to a different subject");

    // Check if already assigned to another module
    const existing = await prisma.taskModuleQuestion.findUnique({ where: { questionId } });
    if (existing) {
      if (existing.moduleId === moduleId) throw new BadRequestError("Question is already in this module");
      throw new BadRequestError("Question is already assigned to another module. Unassign it first.");
    }

    const assignment = await prisma.taskModuleQuestion.create({
      data: { moduleId, questionId },
    });

    res.status(201).json({ success: true, data: assignment });
  } catch (err) { next(err); }
};

export const unassignQuestionFromModule = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const moduleId = req.params.id as string;
    const questionId = req.params.qid as string;

    // Verify module ownership
    const taskModule = await prisma.taskModule.findFirst({ where: { id: moduleId, teacherId, institutionId } });
    if (!taskModule) throw new NotFoundError("Module not found");

    const assignment = await prisma.taskModuleQuestion.findUnique({ where: { questionId } });
    if (!assignment || assignment.moduleId !== moduleId)
      throw new NotFoundError("Question is not assigned to this module");

    await prisma.taskModuleQuestion.delete({ where: { questionId } });

    res.json({ success: true });
  } catch (err) { next(err); }
};
