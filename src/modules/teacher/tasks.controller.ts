// src/modules/teacher/tasks.controller.ts
import { Response, NextFunction } from "express";
import crypto from "crypto";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import {
  generateQuestionsSchema,
  editQuestionSchema,
  createModuleSchema,
  editModuleSchema,
  assignQuestionSchema,
  createTestSchema,
  updateTestSchema,
  addTestQuestionSchema,
  startQuizSchema,
  submitQuizSchema,
  createContainerSchema,
  renameContainerSchema,
} from "./tasks.schema";
import { redis, isRedisReady } from "../../utils/redis";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = require("pdf-parse");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require("pdfkit");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mathjs = require("mathjs");

// ── OpenAI / Groq ─────────────────────────────────────────────────────────────
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
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype === "application/pdf") return cb(null, true);
    cb(new BadRequestError("Only PDF files are accepted for question generation"));
  },
});

// ── Token pool ────────────────────────────────────────────────────────────────
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
const CHUNK_SIZE = 8000;
const CHUNK_OVERLAP = 250;

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  return data.text.trim();
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

async function resolveSubjectAssignment(
  teacherId: string,
  divisionId: string,
  institutionId: string
): Promise<{ subjectId: string; subjectName: string }> {
  const assignment = await prisma.divisionAssignment.findFirst({
    where: { teacherId, divisionId, institutionId, subjectId: { not: null } },
    select: { subjectId: true, subject: { select: { name: true } } },
  });
  if (!assignment?.subjectId || !assignment.subject)
    throw new NotFoundError("No subject assignment found for this teacher in this division");
  return { subjectId: assignment.subjectId, subjectName: assignment.subject.name };
}

// ── Seeded RNG (no external dep) ──────────────────────────────────────────────
function seededRng(seed: string): () => number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (Math.imul(31, hash) + seed.charCodeAt(i)) | 0;
  }
  return function () {
    hash = (Math.imul(2654435761, hash) >>> 0);
    return hash / 0x100000000;
  };
}

function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Formula evaluation ────────────────────────────────────────────────────────
function evalFormula(formula: string, variables: Record<string, number>): number {
  try {
    const result = mathjs.evaluate(formula, { ...variables });
    const n = typeof result === "number" ? result : Number(result);
    return isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function roundNicely(n: number): string {
  if (!isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

// ── Question personalisation for a student ───────────────────────────────────
interface NumericalDetails {
  variables: Record<string, number>;
  correct_answer_formula: string;
  distractor_formulas?: string[];
  category?: string;
}

interface ConceptualDetails {
  correct_answer: string;
  distractors: string[];
  category?: string;
}

type GeneratedQ = {
  questionText: string;
  options: string[];
  correctAnswer: string;
};

function personaliseQuestion(
  q: { id: string; type: string; question: string; questionTemplate: string | null; options: unknown; answer: string; details: unknown },
  rollNo: string
): GeneratedQ {
  const rng = seededRng(rollNo + q.id);

  if (q.type === "NUMERICAL") {
    const d = q.details as NumericalDetails;
    // Randomize variables ±30%
    const newVars: Record<string, number> = {};
    for (const [k, base] of Object.entries(d.variables)) {
      const mult = 0.7 + rng() * 0.6; // 0.7–1.3
      newVars[k] = Math.round(base * mult * 10) / 10;
      if (newVars[k] === 0) newVars[k] = base; // avoid zero
    }

    // Substitute into template
    let questionText = q.questionTemplate ?? q.question;
    for (const [k, v] of Object.entries(newVars)) {
      questionText = questionText.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }

    const correctValue = evalFormula(d.correct_answer_formula, newVars);
    const correctAnswer = roundNicely(correctValue);

    const distractors: string[] = [];
    for (const f of d.distractor_formulas ?? []) {
      const val = evalFormula(f, newVars);
      const str = roundNicely(val);
      if (str !== correctAnswer && !distractors.includes(str)) distractors.push(str);
    }
    // Fill remaining distractors with ±noise
    const attempts = [1.5, 0.5, 2, 0.75, 1.25, 3, 0.33];
    for (const factor of attempts) {
      if (distractors.length >= 3) break;
      const str = roundNicely(correctValue * factor);
      if (str !== correctAnswer && !distractors.includes(str)) distractors.push(str);
    }
    while (distractors.length < 3) distractors.push(roundNicely(correctValue + distractors.length + 1));

    const options = shuffleArray([correctAnswer, ...distractors.slice(0, 3)], rng);
    return { questionText, options, correctAnswer };
  }

  if (q.type === "CONCEPTUAL") {
    const d = q.details as ConceptualDetails;
    const allOpts = shuffleArray([d.correct_answer, ...d.distractors.slice(0, 3)], rng);
    return {
      questionText: q.questionTemplate ?? q.question,
      options: allOpts,
      correctAnswer: d.correct_answer,
    };
  }

  // Legacy MCQ — shuffle existing options
  if (q.type === "MCQ" && Array.isArray(q.options)) {
    const options = shuffleArray(q.options as string[], rng);
    return { questionText: q.question, options, correctAnswer: q.answer };
  }

  // Other types (FILL_BLANK, TRUE_FALSE, SHORT_ANSWER) — no options
  return { questionText: q.question, options: [], correctAnswer: q.answer };
}

// ── AI prompt — full school paper mix ────────────────────────────────────────
const GENERATION_SYSTEM_PROMPT = `You are an expert teacher creating a mixed school exam question paper from study notes.

STRICT REQUIREMENT — you MUST generate questions of ALL of the following types (not just MCQ):
  1. "mcq"          — a question with 4 answer options (correct_answer + 3 distractors)
  2. "fill_blank"   — a sentence with a key word/phrase replaced by ___
  3. "true_false"   — a statement that is either true or false
  4. "short_answer" — a question requiring a 1–3 sentence written answer
  5. "long_answer"  — a question requiring a detailed paragraph answer
  6. "numerical"    — ONLY if the notes contain numbers/calculations; a formula-based problem with variable placeholders like {distance}

Generate approximately 3–4 questions of EACH of types 1–5. Add 1–2 numerical questions ONLY if the content has numbers or formulas. Total: 15–20 questions.

DO NOT generate only MCQ questions. Variety is mandatory.

Language rule: ALWAYS write questions and answers in ENGLISH. If source notes are in another language, translate them.
Basis rule: Every question must come directly from the provided notes — no outside knowledge.
If "Already Generated" list is provided, do not repeat those questions.

For "numerical" type:
- Use {variable_name} placeholders in the question text for numbers that can be varied.
- "variables" must map each placeholder to its original numeric value.
- "correct_answer_formula" must use ONLY the placeholder names and operators: + - * / ( )
- Provide 2 "distractor_formulas" for wrong answers.

Return ONLY a valid JSON object — no markdown fences, no explanation, nothing else:
{
  "questions": [
    { "type": "mcq", "question": "Which organelle is called the powerhouse of the cell?", "details": { "correct_answer": "Mitochondria", "distractors": ["Nucleus", "Ribosome", "Golgi body"], "category": "Biology" } },
    { "type": "fill_blank", "question": "The process by which plants make food using sunlight is called ___.", "details": { "answer": "photosynthesis", "category": "Biology" } },
    { "type": "true_false", "question": "The boiling point of water at sea level is 100°C.", "details": { "answer": "true", "category": "Chemistry" } },
    { "type": "short_answer", "question": "Define Newton's First Law of Motion.", "details": { "answer": "An object at rest remains at rest and an object in motion continues in motion at the same velocity unless acted on by an external unbalanced force.", "category": "Physics" } },
    { "type": "long_answer", "question": "Explain the structure and functions of the human heart.", "details": { "answer": "The human heart has four chambers — two atria and two ventricles. The right side receives deoxygenated blood and pumps it to the lungs; the left side receives oxygenated blood from the lungs and pumps it to the rest of the body. Valves prevent backflow of blood.", "category": "Biology" } },
    { "type": "numerical", "question": "A car travels {distance} km in {time} hours. What is its average speed in km/h?", "details": { "variables": {"distance": 120, "time": 2}, "correct_answer_formula": "distance / time", "distractor_formulas": ["distance * time", "time / distance"], "category": "Physics" } }
  ]
}`;

// ── Background PDF processing ─────────────────────────────────────────────────
async function processPdfInBackground(
  uploadId: string,
  buffer: Buffer,
  teacherId: string,
  subjectId: string,
  institutionId: string,
  promptText: string,
  more: boolean
) {
  try {
    const text = await extractPdfText(buffer);
    if (!text || text.length < 50) {
      await prisma.taskPdfUpload.update({
        where: { id: uploadId },
        data: { status: "failed", errorMessage: "Could not extract readable text from the PDF" },
      });
      return;
    }

    await checkTokenPool(institutionId);

    const chunks = chunkText(text);
    const processChunk = chunks.slice(0, 3); // max 3 chunks per upload

    let existingList = "";
    if (more) {
      const existing = await prisma.taskQuestion.findMany({
        where: { teacherId, subjectId, institutionId },
        select: { question: true },
        take: 50,
      });
      if (existing.length > 0) {
        existingList = `Already Generated (do not repeat):\n${existing.map((q, i) => `${i + 1}. ${q.question}`).join("\n")}\n\n`;
      }
    }

    const allQuestions: Array<Awaited<ReturnType<typeof prisma.taskQuestion.create>>> = [];
    let totalTokens = 0;

    for (const chunk of processChunk) {
      let userMessage = `${existingList}Notes:\n${chunk}`;
      if (promptText?.trim()) userMessage = `Teacher instruction: ${promptText.trim()}\n\n${userMessage}`;

      if (!openai) {
        // Mock fallback — one of each type
        const mocks: Array<{ type: "CONCEPTUAL" | "FILL_BLANK" | "TRUE_FALSE" | "SHORT_ANSWER"; question: string; answer: string; details: object }> = [
          { type: "CONCEPTUAL", question: "Which of the following best describes the main topic of the notes?", answer: "Option A", details: { correct_answer: "Option A", distractors: ["Option B", "Option C", "Option D"], marks: 1, category: "General" } },
          { type: "FILL_BLANK", question: "The key concept discussed is ___.", answer: "the main topic", details: { answer: "the main topic", marks: 1, category: "General" } },
          { type: "TRUE_FALSE", question: "The notes discuss an important educational concept.", answer: "true", details: { answer: "true", marks: 1, category: "General" } },
          { type: "SHORT_ANSWER", question: "Summarise the main idea from the notes in 2–3 sentences.", answer: "The notes cover an important concept relevant to the subject and provide key definitions and examples.", details: { answer: "The notes cover an important concept relevant to the subject.", marks: 2, category: "General" } },
        ];
        for (const q of mocks) {
          allQuestions.push(await prisma.taskQuestion.create({
            data: {
              institutionId, teacherId, subjectId,
              type: q.type, status: "PENDING_REVIEW",
              question: q.question,
              ...(q.type === "CONCEPTUAL" ? { questionTemplate: q.question } : {}),
              answer: q.answer,
              details: JSON.parse(JSON.stringify(q.details)),
              category: "General",
            },
          }));
        }
        break;
      }

      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: GENERATION_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.2,
      });

      totalTokens += completion.usage?.total_tokens ?? 0;

      let parsed: { questions: Array<{ type: string; question: string; details: Record<string, unknown> }> };
      try {
        parsed = JSON.parse(completion.choices[0].message.content ?? "{}");
      } catch {
        continue;
      }

      if (!Array.isArray(parsed.questions)) continue;

      for (const q of parsed.questions.slice(0, 20)) {
        if (!q.type || !q.question || !q.details) continue;
        const aiType = q.type.toLowerCase().replace(/[^a-z_]/g, "");
        const category = (q.details.category as string) ?? null;
        const detailsJson = JSON.parse(JSON.stringify(q.details));

        try {
          if (aiType === "numerical") {
            const d = q.details as unknown as NumericalDetails;
            if (!d.variables || !d.correct_answer_formula) continue;
            const testResult = evalFormula(d.correct_answer_formula, d.variables);
            if (!isFinite(testResult)) continue;
            allQuestions.push(await prisma.taskQuestion.create({
              data: {
                institutionId, teacherId, subjectId,
                type: "NUMERICAL", status: "PENDING_REVIEW",
                question: q.question, questionTemplate: q.question,
                answer: roundNicely(testResult),
                details: detailsJson, category,
              },
            }));

          } else if (aiType === "mcq") {
            const d = q.details as unknown as ConceptualDetails;
            if (!d.correct_answer || !Array.isArray(d.distractors) || d.distractors.length < 3) continue;
            allQuestions.push(await prisma.taskQuestion.create({
              data: {
                institutionId, teacherId, subjectId,
                type: "CONCEPTUAL", status: "PENDING_REVIEW",
                question: q.question, questionTemplate: q.question,
                answer: d.correct_answer,
                details: detailsJson, category,
              },
            }));

          } else if (aiType === "fill_blank") {
            const answer = (q.details.answer as string)?.trim();
            if (!answer) continue;
            allQuestions.push(await prisma.taskQuestion.create({
              data: {
                institutionId, teacherId, subjectId,
                type: "FILL_BLANK", status: "PENDING_REVIEW",
                question: q.question, answer,
                details: detailsJson, category,
              },
            }));

          } else if (aiType === "true_false") {
            const raw = String(q.details.answer ?? "").toLowerCase().trim();
            const answer = raw === "true" || raw === "false" ? raw : null;
            if (!answer) continue;
            allQuestions.push(await prisma.taskQuestion.create({
              data: {
                institutionId, teacherId, subjectId,
                type: "TRUE_FALSE", status: "PENDING_REVIEW",
                question: q.question, answer,
                details: detailsJson, category,
              },
            }));

          } else if (aiType === "short_answer" || aiType === "long_answer") {
            const answer = (q.details.answer as string)?.trim();
            if (!answer) continue;
            allQuestions.push(await prisma.taskQuestion.create({
              data: {
                institutionId, teacherId, subjectId,
                type: "SHORT_ANSWER", status: "PENDING_REVIEW",
                question: q.question, answer,
                details: detailsJson, category,
              },
            }));
          }
        } catch { continue; }
      }
    }

    await deductTokens(institutionId, totalTokens);

    await prisma.taskPdfUpload.update({
      where: { id: uploadId },
      data: { status: "completed", questionCount: allQuestions.length },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await prisma.taskPdfUpload.update({
      where: { id: uploadId },
      data: { status: "failed", errorMessage: msg.slice(0, 500) },
    }).catch(() => {});
  }
}


// ── Generate Questions — returns 202 immediately ──────────────────────────────
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

    // Record the upload
    const upload = await prisma.taskPdfUpload.create({
      data: {
        institutionId, teacherId,
        divisionId: body.divisionId,
        displayName: req.file.originalname || "Uploaded PDF",
        originalName: req.file.originalname || "upload.pdf",
        status: "processing",
      },
    });

    // Fire-and-forget background processing
    const buffer = req.file.buffer;
    setImmediate(() => {
      processPdfInBackground(
        upload.id, buffer, teacherId, subjectId, institutionId,
        body.prompt ?? "", body.more ?? false
      );
    });

    res.status(202).json({ success: true, data: { uploadId: upload.id } });
  } catch (err) { next(err); }
};

// ── PDF Upload status ─────────────────────────────────────────────────────────
export const listUploads = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const divisionId = req.query.divisionId as string;
    if (!divisionId) throw new BadRequestError("divisionId query param is required");

    const uploads = await prisma.taskPdfUpload.findMany({
      where: { teacherId, institutionId, divisionId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    res.json({ success: true, data: uploads });
  } catch (err) { next(err); }
};

export const getUploadStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const upload = await prisma.taskPdfUpload.findFirst({ where: { id, teacherId, institutionId } });
    if (!upload) throw new NotFoundError("Upload not found");

    res.json({ success: true, data: upload });
  } catch (err) { next(err); }
};

// ── Question Bank CRUD ────────────────────────────────────────────────────────
export const listQuestions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const divisionId = req.query.divisionId as string;
    const statusFilter = req.query.status as string | undefined;

    if (!divisionId) throw new BadRequestError("divisionId query param is required");

    const { subjectId } = await resolveSubjectAssignment(teacherId, divisionId, institutionId);

    const questions = await prisma.taskQuestion.findMany({
      where: {
        teacherId, subjectId, institutionId,
        ...(statusFilter && ["PENDING_REVIEW", "APPROVED", "REJECTED"].includes(statusFilter)
          ? { status: statusFilter as "PENDING_REVIEW" | "APPROVED" | "REJECTED" }
          : {}),
      },
      include: { moduleAssignment: { select: { moduleId: true, module: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: questions });
  } catch (err) { next(err); }
};

export const updateQuestionStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;
    const { status } = req.body as { status: string };

    if (!["PENDING_REVIEW", "APPROVED", "REJECTED"].includes(status))
      throw new BadRequestError("Invalid status");

    const question = await prisma.taskQuestion.findFirst({ where: { id, teacherId, institutionId } });
    if (!question) throw new NotFoundError("Question not found");

    const updated = await prisma.taskQuestion.update({
      where: { id },
      data: { status: status as "PENDING_REVIEW" | "APPROVED" | "REJECTED" },
    });

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

export const editQuestion = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;
    const data = editQuestionSchema.parse(req.body);

    const question = await prisma.taskQuestion.findFirst({ where: { id, teacherId, institutionId } });
    if (!question) throw new NotFoundError("Question not found");

    // Validate MCQ constraints
    if (question.type === "MCQ") {
      if (!data.options || data.options.length !== 4)
        throw new BadRequestError("MCQ questions require exactly 4 options");
      if (!data.options.includes(data.answer))
        throw new BadRequestError("Answer must be one of the provided options");
    }
    if (question.type === "TRUE_FALSE" && !["true", "false"].includes(data.answer.toLowerCase()))
      throw new BadRequestError("True/False answer must be 'true' or 'false'");

    const updated = await prisma.taskQuestion.update({
      where: { id },
      data: {
        question: data.question,
        questionTemplate: data.questionTemplate ?? question.questionTemplate,
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

    const question = await prisma.taskQuestion.findFirst({ where: { id, teacherId, institutionId } });
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
      where: { teacherId, subjectId, institutionId, status: "APPROVED" },
      orderBy: [{ type: "asc" }, { createdAt: "asc" }],
    });

    if (questions.length === 0) throw new BadRequestError("No approved questions to export");

    const teacher = await prisma.teacher.findFirst({
      where: { id: teacherId, institutionId },
      select: { user: { select: { name: true } } },
    });

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${subjectName.replace(/\s+/g, "_")}_Question_Bank.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).font("Helvetica-Bold").text(`${subjectName} — Question Bank`, { align: "center" });
    doc.fontSize(10).font("Helvetica").fillColor("#666666")
      .text(`Teacher: ${teacher?.user?.name ?? "Unknown"}   |   Generated: ${new Date().toLocaleDateString("en-IN")}`, { align: "center" });
    doc.moveDown(1.5);

    const TYPE_LABELS: Record<string, string> = {
      MCQ: "Multiple Choice", FILL_BLANK: "Fill in the Blank",
      TRUE_FALSE: "True / False", SHORT_ANSWER: "Short Answer",
      NUMERICAL: "Numerical / Calculation", CONCEPTUAL: "Conceptual",
    };

    let qNumber = 1;
    for (const type of ["NUMERICAL", "CONCEPTUAL", "MCQ", "FILL_BLANK", "TRUE_FALSE", "SHORT_ANSWER"] as const) {
      const group = questions.filter(q => q.type === type);
      if (group.length === 0) continue;

      doc.fontSize(13).font("Helvetica-Bold").fillColor("#000000").text(TYPE_LABELS[type], { underline: true });
      doc.moveDown(0.5);

      for (const q of group) {
        doc.fontSize(11).font("Helvetica-Bold").fillColor("#000000").text(`Q${qNumber}. ${q.question}`);

        if (q.type === "MCQ" && Array.isArray(q.options)) {
          const opts = q.options as string[];
          opts.forEach((opt, i) => {
            doc.fontSize(10).font("Helvetica").fillColor("#333333").text(`   ${"abcd"[i]}) ${opt}`);
          });
        } else if (q.type === "NUMERICAL") {
          const d = q.details as NumericalDetails | null;
          if (d?.variables) {
            const vars = Object.entries(d.variables).map(([k, v]) => `${k}=${v}`).join(", ");
            doc.fontSize(9).font("Helvetica").fillColor("#555555").text(`   Variables: ${vars}`);
            doc.fontSize(9).font("Helvetica").fillColor("#555555").text(`   Formula: ${d.correct_answer_formula}`);
          }
        } else if (q.type === "CONCEPTUAL") {
          const d = q.details as ConceptualDetails | null;
          if (d?.distractors) {
            const opts = shuffleArray([q.answer, ...d.distractors.slice(0, 3)], seededRng(q.id));
            opts.forEach((opt, i) => {
              doc.fontSize(10).font("Helvetica").fillColor("#333333").text(`   ${"abcd"[i]}) ${opt}`);
            });
          }
        }

        doc.fontSize(9).font("Helvetica-Oblique").fillColor("#1a6b3a").text(`   Answer: ${q.answer}`);
        doc.moveDown(0.7);
        qNumber++;
      }
      doc.moveDown(0.5);
    }

    doc.end();
  } catch (err) { next(err); }
};

// ── Tests CRUD ────────────────────────────────────────────────────────────────
export const listTests = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const divisionId = req.query.divisionId as string;
    if (!divisionId) throw new BadRequestError("divisionId query param is required");

    const tests = await prisma.taskTest.findMany({
      where: { teacherId, divisionId, institutionId },
      include: {
        questions: { select: { id: true, isCompulsory: true } },
        _count: { select: { attempts: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: tests });
  } catch (err) { next(err); }
};

export const createTest = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const data = createTestSchema.parse(req.body);

    const { subjectId } = await resolveSubjectAssignment(teacherId, data.divisionId, institutionId);

    const testLink = crypto.randomBytes(6).toString("base64url");

    const test = await prisma.taskTest.create({
      data: {
        institutionId, teacherId, subjectId,
        divisionId: data.divisionId,
        title: data.title,
        description: data.description ?? null,
        testLink,
        durationMinutes: data.durationMinutes ?? 60,
        marksPerQuestion: data.marksPerQuestion ?? 1,
        numberOfQuestions: data.numberOfQuestions,
        maxAttempts: data.maxAttempts ?? 1,
        validUntil: data.validUntil ? new Date(data.validUntil) : null,
      },
      include: {
        questions: { select: { id: true, isCompulsory: true } },
        _count: { select: { attempts: true } },
      },
    });

    res.status(201).json({ success: true, data: test });
  } catch (err) { next(err); }
};

export const getTest = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const test = await prisma.taskTest.findFirst({
      where: { id, teacherId, institutionId },
      include: {
        questions: {
          include: {
            question: {
              select: { id: true, type: true, status: true, question: true, questionTemplate: true, answer: true, options: true, details: true, category: true },
            },
          },
          orderBy: { order: "asc" },
        },
        _count: { select: { attempts: true } },
      },
    });

    if (!test) throw new NotFoundError("Test not found");

    res.json({ success: true, data: test });
  } catch (err) { next(err); }
};

export const updateTest = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;
    const data = updateTestSchema.parse(req.body);

    const test = await prisma.taskTest.findFirst({ where: { id, teacherId, institutionId } });
    if (!test) throw new NotFoundError("Test not found");
    if (test.status === "COMPLETED") throw new BadRequestError("Cannot edit a completed test");

    const updated = await prisma.taskTest.update({
      where: { id },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.durationMinutes !== undefined && { durationMinutes: data.durationMinutes }),
        ...(data.marksPerQuestion !== undefined && { marksPerQuestion: data.marksPerQuestion }),
        ...(data.numberOfQuestions !== undefined && { numberOfQuestions: data.numberOfQuestions }),
        ...(data.maxAttempts !== undefined && { maxAttempts: data.maxAttempts }),
        ...(data.validUntil !== undefined && { validUntil: data.validUntil ? new Date(data.validUntil) : null }),
        ...(data.status !== undefined && { status: data.status }),
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

export const savePaper = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const { title, description, paperType, durationMinutes, maxAttempts, validUntil, isRandomized, sections, questions } =
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(1000).optional().nullable(),
        paperType: z.enum(["TEST", "ASSIGNMENT"]).default("TEST"),
        durationMinutes: z.number().int().min(1).max(600).default(60),
        maxAttempts: z.number().int().min(1).max(10).default(1),
        validUntil: z.string().optional().nullable(),
        isRandomized: z.boolean().default(false),
        sections: z.array(z.object({
          id: z.string(),
          title: z.string(),
          instruction: z.string().optional().default(""),
          questionTypes: z.array(z.string()),
          marksPerQuestion: z.number().int().min(0).default(1),
        })).optional().default([]),
        questions: z.array(z.object({
          questionId: z.string().uuid(),
          sectionId: z.string().optional().nullable(),
          marks: z.number().int().min(0).optional().nullable(),
          order: z.number().int().min(0).default(0),
          isCompulsory: z.boolean().default(true),
        })).default([]),
      }).parse(req.body);

    const test = await prisma.taskTest.findFirst({ where: { id, teacherId, institutionId } });
    if (!test) throw new NotFoundError("Test not found");
    if (test.status === "COMPLETED") throw new BadRequestError("Cannot edit a completed test");

    // Verify all questions belong to this teacher and are approved
    if (questions.length > 0) {
      const qIds = questions.map(q => q.questionId);
      const validQs = await prisma.taskQuestion.findMany({
        where: { id: { in: qIds }, teacherId, institutionId, status: "APPROVED" },
        select: { id: true },
      });
      if (validQs.length !== qIds.length) throw new BadRequestError("One or more questions not found or not approved");
    }

    await prisma.$transaction(async (tx) => {
      await tx.taskTest.update({
        where: { id },
        data: {
          title,
          description: description ?? null,
          paperType,
          durationMinutes,
          maxAttempts,
          isRandomized,
          sections: sections.length > 0 ? JSON.parse(JSON.stringify(sections)) : null,
          numberOfQuestions: questions.length,
          validUntil: validUntil ? new Date(validUntil) : null,
        },
      });

      // Full replace of questions
      await tx.taskTestQuestion.deleteMany({ where: { testId: id } });

      if (questions.length > 0) {
        await tx.taskTestQuestion.createMany({
          data: questions.map(q => ({
            testId: id,
            questionId: q.questionId,
            sectionId: q.sectionId ?? null,
            marks: q.marks ?? null,
            order: q.order,
            isCompulsory: q.isCompulsory,
          })),
        });
      }
    });

    const updated = await prisma.taskTest.findFirst({
      where: { id },
      include: {
        questions: {
          include: {
            question: {
              select: { id: true, type: true, status: true, question: true, questionTemplate: true, answer: true, options: true, details: true, category: true },
            },
          },
          orderBy: { order: "asc" },
        },
        _count: { select: { attempts: true } },
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

export const deleteTest = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const test = await prisma.taskTest.findFirst({ where: { id, teacherId, institutionId } });
    if (!test) throw new NotFoundError("Test not found");

    await prisma.taskTest.delete({ where: { id } });

    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── Test Question Management ──────────────────────────────────────────────────
export const addTestQuestion = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const testId = req.params.id as string;
    const data = addTestQuestionSchema.parse(req.body);

    const test = await prisma.taskTest.findFirst({ where: { id: testId, teacherId, institutionId } });
    if (!test) throw new NotFoundError("Test not found");
    if (test.status === "COMPLETED") throw new BadRequestError("Cannot modify a completed test");

    // Verify question ownership
    const question = await prisma.taskQuestion.findFirst({
      where: { id: data.questionId, teacherId, institutionId, status: "APPROVED" },
    });
    if (!question) throw new NotFoundError("Approved question not found");

    const existing = await prisma.taskTestQuestion.findUnique({
      where: { testId_questionId: { testId, questionId: data.questionId } },
    });
    if (existing) throw new BadRequestError("Question is already in this test");

    const tq = await prisma.taskTestQuestion.create({
      data: { testId, questionId: data.questionId, isCompulsory: data.isCompulsory ?? false },
    });

    res.status(201).json({ success: true, data: tq });
  } catch (err) { next(err); }
};

export const removeTestQuestion = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const testId = req.params.id as string;
    const questionId = req.params.qid as string;

    const test = await prisma.taskTest.findFirst({ where: { id: testId, teacherId, institutionId } });
    if (!test) throw new NotFoundError("Test not found");
    if (test.status === "ACTIVE") throw new BadRequestError("Cannot remove questions from an active test");

    const tq = await prisma.taskTestQuestion.findUnique({
      where: { testId_questionId: { testId, questionId } },
    });
    if (!tq) throw new NotFoundError("Question not in this test");

    await prisma.taskTestQuestion.delete({ where: { testId_questionId: { testId, questionId } } });

    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── Test Results ──────────────────────────────────────────────────────────────
export const getTestResults = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const test = await prisma.taskTest.findFirst({ where: { id, teacherId, institutionId } });
    if (!test) throw new NotFoundError("Test not found");

    const attempts = await prisma.taskTestAttempt.findMany({
      where: { testId: id, status: "completed" },
      include: {
        answers: {
          select: { questionId: true, isCorrect: true, studentAnswer: true, correctAnswer: true, generatedQuestion: true },
        },
      },
      orderBy: { totalScore: "desc" },
    });

    res.json({ success: true, data: { test, attempts } });
  } catch (err) { next(err); }
};

// ── Containers ────────────────────────────────────────────────────────────────
export const listContainers = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const divisionId = req.query.divisionId as string;
    if (!divisionId) throw new BadRequestError("divisionId query param is required");

    const { subjectId } = await resolveSubjectAssignment(teacherId, divisionId, institutionId);

    const containers = await prisma.taskContainer.findMany({
      where: { teacherId, subjectId, divisionId, institutionId },
      include: { _count: { select: { questions: true } } },
      orderBy: { createdAt: "desc" },
    });

    const data = containers.map((c) => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt,
      questionCount: c._count.questions,
    }));

    res.json({ success: true, data });
  } catch (err) { next(err); }
};

export const createContainer = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const data = createContainerSchema.parse(req.body);

    const { subjectId } = await resolveSubjectAssignment(teacherId, data.divisionId, institutionId);

    const container = await prisma.taskContainer.create({
      data: { institutionId, teacherId, subjectId, divisionId: data.divisionId, name: data.name },
    });

    res.status(201).json({
      success: true,
      data: { id: container.id, name: container.name, createdAt: container.createdAt, questionCount: 0 },
    });
  } catch (err) { next(err); }
};

export const renameContainer = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;
    const { name } = renameContainerSchema.parse(req.body);

    const container = await prisma.taskContainer.findFirst({
      where: { id, teacherId, institutionId },
      include: { _count: { select: { questions: true } } },
    });
    if (!container) throw new NotFoundError("Container not found");

    await prisma.taskContainer.updateMany({
      where: { id, teacherId, institutionId },
      data: { name },
    });

    res.json({
      success: true,
      data: { id: container.id, name, createdAt: container.createdAt, questionCount: container._count.questions },
    });
  } catch (err) { next(err); }
};

export const deleteContainer = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const container = await prisma.taskContainer.findFirst({ where: { id, teacherId, institutionId } });
    if (!container) throw new NotFoundError("Container not found");

    // onDelete: Cascade on TaskQuestion.containerId removes the questions inside.
    await prisma.taskContainer.deleteMany({ where: { id, teacherId, institutionId } });

    res.json({ success: true });
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
              select: { id: true, type: true, status: true, question: true, options: true, answer: true, createdAt: true, details: true, category: true },
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

    const taskModule = await prisma.taskModule.findFirst({ where: { id: moduleId, teacherId, institutionId } });
    if (!taskModule) throw new NotFoundError("Module not found");

    const question = await prisma.taskQuestion.findFirst({
      where: { id: questionId, teacherId, institutionId, subjectId: taskModule.subjectId },
    });
    if (!question) throw new NotFoundError("Question not found or belongs to a different subject");

    const existing = await prisma.taskModuleQuestion.findUnique({ where: { questionId } });
    if (existing) {
      if (existing.moduleId === moduleId) throw new BadRequestError("Question is already in this module");
      throw new BadRequestError("Question is already assigned to another module. Unassign it first.");
    }

    const assignment = await prisma.taskModuleQuestion.create({ data: { moduleId, questionId } });

    res.status(201).json({ success: true, data: assignment });
  } catch (err) { next(err); }
};

export const unassignQuestionFromModule = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const moduleId = req.params.id as string;
    const questionId = req.params.qid as string;

    const taskModule = await prisma.taskModule.findFirst({ where: { id: moduleId, teacherId, institutionId } });
    if (!taskModule) throw new NotFoundError("Module not found");

    const assignment = await prisma.taskModuleQuestion.findUnique({ where: { questionId } });
    if (!assignment || assignment.moduleId !== moduleId)
      throw new NotFoundError("Question is not assigned to this module");

    await prisma.taskModuleQuestion.delete({ where: { questionId } });

    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── Public Quiz Routes (no auth) ──────────────────────────────────────────────
export const getQuizInfo = async (req: import("express").Request, res: Response, next: NextFunction) => {
  try {
    const testLink = req.params.testLink as string;
    const studentName =
      typeof req.query.name === "string" ? req.query.name.trim() : undefined;
    const rollNo =
      typeof req.query.roll_number === "string"
        ? req.query.roll_number.trim()
        : typeof req.query.rollNo === "string"
          ? req.query.rollNo.trim()
          : undefined;

    const test = await prisma.taskTest.findUnique({
      where: { testLink },
      select: {
        id: true, title: true, description: true, status: true,
        durationMinutes: true, marksPerQuestion: true, numberOfQuestions: true,
        maxAttempts: true, validUntil: true, testLink: true, divisionId: true,
        institutionId: true,
      },
    });

    if (!test) throw new NotFoundError("Test not found");
    if (test.status === "DRAFT") throw new BadRequestError("This test is not yet active");
    if (test.validUntil && new Date(test.validUntil) < new Date())
      throw new BadRequestError("This test has expired");

    let attempts: Array<{ id: string; totalScore: number; endTime: Date | null; attemptNumber: number }> = [];

    if (studentName && rollNo) {
      const student = await prisma.student.findFirst({
        where: {
          divisionId: test.divisionId,
          institutionId: test.institutionId,
          rollNo,
          user: { name: { equals: studentName, mode: "insensitive" } },
        },
        select: { id: true },
      });

      if (!student) {
        throw new BadRequestError("The name and roll number combination is not registered for this test.");
      }

      attempts = await prisma.taskTestAttempt.findMany({
        where: { testId: test.id, studentId: student.id, status: "completed" },
        select: { id: true, totalScore: true, endTime: true, attemptNumber: true },
        orderBy: { attemptNumber: "asc" },
      });
    }

    res.json({
      success: true,
      data: test,
      test: {
        ...test,
        test_link: test.testLink,
        duration_minutes: test.durationMinutes,
        marks_per_question: test.marksPerQuestion,
        number_of_questions: test.numberOfQuestions,
        max_attempts: test.maxAttempts,
        valid_until: test.validUntil,
      },
      attempts: attempts.map((attempt) => ({
        ...attempt,
        total_score: attempt.totalScore,
        end_time: attempt.endTime,
        attempt_number: attempt.attemptNumber,
      })),
    });
  } catch (err) { next(err); }
};

export const startQuiz = async (req: import("express").Request, res: Response, next: NextFunction) => {
  try {
    const testLink = req.params.testLink as string;
    const { studentName, rollNo } = startQuizSchema.parse({
      studentName: req.body.studentName ?? req.body.student_name,
      rollNo: req.body.rollNo ?? req.body.roll_number,
    });

    const test = await prisma.taskTest.findUnique({
      where: { testLink },
      include: {
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
    if (test.validUntil && new Date(test.validUntil) < new Date())
      throw new BadRequestError("This test has expired");

    // Check attempt count
    const priorAttempts = await prisma.taskTestAttempt.count({
      where: { testId: test.id, rollNo, status: "completed" },
    });
    if (priorAttempts >= test.maxAttempts)
      throw new BadRequestError("Maximum attempts reached for this test");

    // Check for existing in-progress attempt
    const inProgress = await prisma.taskTestAttempt.findFirst({
      where: { testId: test.id, rollNo, status: "in_progress" },
    });
    if (inProgress) throw new BadRequestError("You have an attempt already in progress");

    // Find student in DB if rollNo matches
    const student = await prisma.student.findFirst({
      where: {
        divisionId: test.divisionId,
        rollNo,
        institutionId: test.institutionId,
      },
      select: { id: true, user: { select: { name: true } } },
    });

    if (!student) {
      throw new BadRequestError("The name and roll number combination is not registered for this test.");
    }

    const registeredName = student.user.name?.trim().toLowerCase();
    if (!registeredName || registeredName !== studentName.trim().toLowerCase()) {
      throw new BadRequestError("The name and roll number combination is not registered for this test.");
    }

    // Select questions: all compulsory + random pool to fill numberOfQuestions
    const compulsory = test.questions.filter(tq => tq.isCompulsory);
    const pool = test.questions.filter(tq => !tq.isCompulsory);

    const rng = seededRng(rollNo + test.id + Date.now().toString());
    const shuffledPool = shuffleArray(pool, rng);
    const needed = Math.max(0, test.numberOfQuestions - compulsory.length);
    const selected = [...compulsory, ...shuffledPool.slice(0, needed)];

    // Create attempt
    const attempt = await prisma.taskTestAttempt.create({
      data: {
        testId: test.id,
        studentId: student?.id ?? null,
        studentName,
        rollNo,
        attemptNumber: priorAttempts + 1,
        maxScore: selected.length * test.marksPerQuestion,
        status: "in_progress",
      },
    });

    // Generate personalized questions
    const personalised = selected.map(tq => {
      const q = tq.question;
      const gen = personaliseQuestion(q, rollNo);
      return {
        questionId: q.id,
        questionText: gen.questionText,
        options: gen.options,
        correctAnswer: gen.correctAnswer,
        type: q.type,
      };
    });

    // Shuffle question order per student
    const orderedQ = shuffleArray(personalised, seededRng(rollNo + test.id));

    res.json({
      success: true,
      data: {
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        testTitle: test.title,
        durationMinutes: test.durationMinutes,
        marksPerQuestion: test.marksPerQuestion,
        questions: orderedQ.map(q => ({
          questionId: q.questionId,
          questionText: q.questionText,
          options: q.options,
          type: q.type,
        })),
        // Store correctAnswers separately — never sent to client
        _meta: { totalQuestions: orderedQ.length },
      },
      attemptId: attempt.id,
      attempt_number: attempt.attemptNumber,
      duration_minutes: test.durationMinutes,
      marks_per_question: test.marksPerQuestion,
      questions: orderedQ.map(q => ({
        id: q.questionId,
        questionId: q.questionId,
        question: q.questionText,
        questionText: q.questionText,
        options: q.options,
        type: q.type,
      })),
    });

    // Save generated questions to answers table (for scoring later)
    setImmediate(async () => {
      await prisma.taskStudentAnswer.createMany({
        data: orderedQ.map(q => ({
          attemptId: attempt.id,
          questionId: q.questionId,
          generatedQuestion: q.questionText,
          ...(q.options.length > 0 ? { generatedOptions: JSON.parse(JSON.stringify(q.options)) } : {}),
          correctAnswer: q.correctAnswer,
          isCorrect: false,
        })),
        skipDuplicates: true,
      });
    });
  } catch (err) { next(err); }
};

export const submitQuiz = async (req: import("express").Request, res: Response, next: NextFunction) => {
  try {
    const testLink = req.params.testLink as string;
    const legacyAnswers = req.body.answers && !Array.isArray(req.body.answers)
      ? Object.entries(req.body.answers as Record<string, unknown>).map(([questionId, answer]) => ({
          questionId,
          answer: typeof answer === "string" ? answer : answer == null ? null : String(answer),
        }))
      : undefined;
    const normalized = submitQuizSchema.parse({
      attemptId: req.body.attemptId,
      answers: legacyAnswers ?? req.body.answers,
    });
    let attemptId = normalized.attemptId;
    const answers = normalized.answers;

    const test = await prisma.taskTest.findUnique({ where: { testLink } });
    if (!test) throw new NotFoundError("Test not found");

    if (!attemptId) {
      const rollNo = typeof req.body.rollNo === "string"
        ? req.body.rollNo.trim()
        : typeof req.body.roll_number === "string"
          ? req.body.roll_number.trim()
          : "";
      const attemptNumber = Number(req.body.attempt_number);
      if (!rollNo || !Number.isInteger(attemptNumber) || attemptNumber < 1) {
        throw new BadRequestError("attemptId is required");
      }

      const inProgressAttempt = await prisma.taskTestAttempt.findFirst({
        where: {
          testId: test.id,
          rollNo,
          attemptNumber,
          status: "in_progress",
        },
        select: { id: true },
      });

      if (!inProgressAttempt) {
        throw new NotFoundError("Attempt not found or already submitted");
      }
      attemptId = inProgressAttempt.id;
    }

    const attempt = await prisma.taskTestAttempt.findFirst({
      where: { id: attemptId, testId: test.id, status: "in_progress" },
    });
    if (!attempt) throw new NotFoundError("Attempt not found or already submitted");

    // Get stored answers to compare
    const storedAnswers = await prisma.taskStudentAnswer.findMany({
      where: { attemptId },
    });

    // Score each answer
    let totalScore = 0;
    const updates: Array<{ id: string; studentAnswer: string; isCorrect: boolean }> = [];

    for (const submitted of answers) {
      const stored = storedAnswers.find(sa => sa.questionId === submitted.questionId);
      if (!stored) continue;

      const isCorrect = submitted.answer?.trim().toLowerCase() === stored.correctAnswer.trim().toLowerCase();
      if (isCorrect) totalScore += test.marksPerQuestion;

      updates.push({ id: stored.id, studentAnswer: submitted.answer ?? "", isCorrect });
    }

    // Bulk update in transaction
    await prisma.$transaction([
      ...updates.map(u =>
        prisma.taskStudentAnswer.update({
          where: { id: u.id },
          data: { studentAnswer: u.studentAnswer, isCorrect: u.isCorrect },
        })
      ),
      prisma.taskTestAttempt.update({
        where: { id: attemptId },
        data: {
          status: "completed",
          endTime: new Date(),
          totalScore,
        },
      }),
    ]);

    const maxScore = attempt.maxScore;
    const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

    res.json({
      success: true,
      data: {
        attemptId,
        totalScore,
        maxScore,
        percentage,
        correct: updates.filter(u => u.isCorrect).length,
        total: storedAnswers.length,
      },
      score: totalScore,
      attemptId,
      questions: storedAnswers.map((stored) => {
        const submitted = updates.find((u) => u.id === stored.id);
        return {
          questionText: stored.generatedQuestion,
          studentAnswer: submitted?.studentAnswer ?? stored.studentAnswer,
          correctAnswer: stored.correctAnswer,
          isCorrect: submitted?.isCorrect ?? stored.isCorrect,
        };
      }),
    });
  } catch (err) { next(err); }
};

export const getAttemptResult = async (req: import("express").Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    const attempt = await prisma.taskTestAttempt.findUnique({
      where: { id },
      include: {
        test: { select: { title: true, marksPerQuestion: true } },
        answers: {
          select: {
            questionId: true, generatedQuestion: true, generatedOptions: true,
            studentAnswer: true, correctAnswer: true, isCorrect: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!attempt) throw new NotFoundError("Attempt not found");
    if (attempt.status !== "completed") throw new BadRequestError("Attempt is not yet submitted");

    res.json({ success: true, data: attempt });
  } catch (err) { next(err); }
};

export const getAttemptDetailsForPdf = async (req: import("express").Request, res: Response, next: NextFunction) => {
  try {
    const attemptId = req.params.id as string;

    const attempt = await prisma.taskTestAttempt.findUnique({
      where: { id: attemptId },
      include: {
        test: { select: { title: true, marksPerQuestion: true } },
        answers: {
          select: {
            generatedQuestion: true,
            studentAnswer: true,
            correctAnswer: true,
            isCorrect: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!attempt) throw new NotFoundError("Attempt not found");
    if (attempt.answers.length === 0) throw new NotFoundError("No answer details found for this attempt.");

    res.json(
      attempt.answers.map((answer) => ({
        generated_question: answer.generatedQuestion,
        student_answer: answer.studentAnswer,
        correct_answer: answer.correctAnswer,
        is_correct: answer.isCorrect,
        test_title: attempt.test.title,
        marks_per_question: attempt.test.marksPerQuestion,
        student_name: attempt.studentName,
        student_roll_number: attempt.rollNo,
        total_score: attempt.totalScore,
        end_time: attempt.endTime,
        attempt_number: attempt.attemptNumber,
        tab_change_count: attempt.tabChangeCount,
      }))
    );
  } catch (err) { next(err); }
};

export const beaconSubmitQuiz = async (req: import("express").Request, res: Response, next: NextFunction) => {
  return submitQuiz(req, res, next);
};
