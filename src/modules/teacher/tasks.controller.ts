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
  reorderModulesSchema,
  reorderModuleQuestionsSchema,
  assignQuestionSchema,
  createTestSchema,
  updateTestSchema,
  addTestQuestionSchema,
  startQuizSchema,
  submitQuizSchema,
  createContainerSchema,
  renameContainerSchema,
  createManualQuestionSchema,
  createShareTokenSchema,
  importQuestionsSchema,
  createAssignmentSchema,
  updateAssignmentSchema,
} from "./tasks.schema";
import { redis, isRedisReady } from "../../utils/redis";
import { getAiTokenLimit } from "../../services/billing.service";
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
  // See blackboard.controller.ts#checkTokenPool — a Redis timeout here would
  // otherwise surface as a 500 rather than degrading gracefully.
  const [used, limitN] = await Promise.all([
    redis.get(`ai:usage:institution:${institutionId}`).catch((err) => {
      console.warn("[tasks] Token-pool read failed, allowing request:", err?.message ?? err);
      return null;
    }),
    getAiTokenLimit(institutionId),
  ]);
  const usedN = Number(used ?? 0);
  if (limitN > 0 && usedN >= limitN) {
    throw Object.assign(new Error("Token limit reached"), { statusCode: 429 });
  }
}

async function deductTokens(institutionId: string, tokens: number, teacherId?: string): Promise<void> {
  if (!redis || !isRedisReady || tokens <= 0) return;
  await redis.incrby(`ai:usage:institution:${institutionId}`, tokens).catch(() => {});
  if (teacherId) await redis.incrby(`ai:usage:teacher:${teacherId}`, tokens).catch(() => {});
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
  institutionId: string,
  subjectId?: string
): Promise<{ subjectId: string; subjectName: string }> {
  const where = subjectId
    ? { teacherId, divisionId, institutionId, subjectId }
    : { teacherId, divisionId, institutionId, subjectId: { not: null as null } };
  const assignment = await prisma.divisionAssignment.findFirst({
    where,
    select: { subjectId: true, subject: { select: { name: true } } },
  });
  if (!assignment?.subjectId || !assignment.subject)
    throw new NotFoundError("No subject assignment found for this teacher in this division");
  return { subjectId: assignment.subjectId, subjectName: assignment.subject.name };
}

// ── Seeded RNG (no external dep) ──────────────────────────────────────────────
export function seededRng(seed: string): () => number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (Math.imul(31, hash) + seed.charCodeAt(i)) | 0;
  }
  return function () {
    hash = (Math.imul(2654435761, hash) >>> 0);
    return hash / 0x100000000;
  };
}

export function shuffleArray<T>(arr: T[], rng: () => number): T[] {
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

export type GeneratedQ = {
  questionText: string;
  options: string[];
  correctAnswer: string;
};

export function personaliseQuestion(
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
  more: boolean,
  containerId: string,
  sourceFile: string
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
              institutionId, teacherId, subjectId, containerId, sourceFile, uploadBatchId: uploadId, source: "AI",
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
                institutionId, teacherId, subjectId, containerId, sourceFile, uploadBatchId: uploadId, source: "AI",
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
                institutionId, teacherId, subjectId, containerId, sourceFile, uploadBatchId: uploadId, source: "AI",
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
                institutionId, teacherId, subjectId, containerId, sourceFile, uploadBatchId: uploadId, source: "AI",
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
                institutionId, teacherId, subjectId, containerId, sourceFile, uploadBatchId: uploadId, source: "AI",
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
                institutionId, teacherId, subjectId, containerId, sourceFile, uploadBatchId: uploadId, source: "AI",
                type: "SHORT_ANSWER", status: "PENDING_REVIEW",
                question: q.question, answer,
                details: detailsJson, category,
              },
            }));
          }
        } catch { continue; }
      }
    }

    await deductTokens(institutionId, totalTokens, teacherId);

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
      containerId: req.body.containerId,
      prompt: req.body.prompt,
      more: req.body.more === "true" || req.body.more === true,
    });

    const container = await prisma.taskContainer.findFirst({
      where: { id: body.containerId, teacherId, institutionId },
      select: { id: true, subjectId: true, divisionId: true },
    });
    if (!container) throw new NotFoundError("Container not found");

    // Record the upload
    const upload = await prisma.taskPdfUpload.create({
      data: {
        institutionId, teacherId,
        divisionId: container.divisionId,
        containerId: container.id,
        displayName: req.file.originalname || "Uploaded PDF",
        originalName: req.file.originalname || "upload.pdf",
        status: "processing",
      },
    });

    // Fire-and-forget background processing
    const buffer = req.file.buffer;
    setImmediate(() => {
      processPdfInBackground(
        upload.id, buffer, teacherId, container.subjectId, institutionId,
        body.prompt ?? "", body.more ?? false, container.id, upload.displayName
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
    const containerId = req.query.containerId as string;
    const statusFilter = req.query.status as string | undefined;

    if (!containerId) throw new BadRequestError("containerId query param is required");

    const container = await prisma.taskContainer.findFirst({
      where: { id: containerId, teacherId, institutionId },
      select: { id: true },
    });
    if (!container) throw new NotFoundError("Container not found");

    const questions = await prisma.taskQuestion.findMany({
      where: {
        containerId, teacherId, institutionId,
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

export const createManualQuestion = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const data = createManualQuestionSchema.parse(req.body);

    const container = await prisma.taskContainer.findFirst({
      where: { id: data.containerId, teacherId, institutionId },
      select: { id: true, subjectId: true },
    });
    if (!container) throw new NotFoundError("Container not found");

    if ((data.type === "MCQ" || data.type === "CONCEPTUAL") && (!data.options || data.options.length !== 4))
      throw new BadRequestError("MCQ/Conceptual questions require exactly 4 options");
    if ((data.type === "MCQ" || data.type === "CONCEPTUAL") && !data.options!.includes(data.answer))
      throw new BadRequestError("Answer must be one of the provided options");
    if (data.type === "TRUE_FALSE" && !["true", "false"].includes(data.answer.toLowerCase()))
      throw new BadRequestError("True/False answer must be 'true' or 'false'");
    if (data.type === "NUMERICAL" && isNaN(Number(data.answer)))
      throw new BadRequestError("Numerical answer must be a valid number");

    let details: Record<string, unknown> | null = null;
    if (data.type === "CONCEPTUAL" && data.options) {
      details = {
        correct_answer: data.answer,
        distractors: data.options.filter((o) => o !== data.answer),
        ...(data.category ? { category: data.category } : {}),
      };
    } else if (data.type === "NUMERICAL") {
      details = {
        correct_answer_formula: data.formula || data.answer,
        variables: {},
        ...(data.category ? { category: data.category } : {}),
      };
    }

    const question = await prisma.taskQuestion.create({
      data: {
        institutionId,
        teacherId,
        subjectId: container.subjectId,
        containerId: data.containerId,
        type: data.type,
        status: "APPROVED",
        source: "MANUAL",
        question: data.question,
        ...(data.type === "NUMERICAL" ? { questionTemplate: data.question } : {}),
        answer: data.answer,
        options: data.type === "MCQ" ? (data.options as string[]) : undefined,
        details: details ? JSON.parse(JSON.stringify(details)) : undefined,
        category: data.category ?? undefined,
      },
      include: { moduleAssignment: { select: { moduleId: true, module: { select: { name: true } } } } },
    });

    res.status(201).json({ success: true, data: question });
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

// ── Question Sharing ──────────────────────────────────────────────────────────

export const createShareToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const { questionIds } = createShareTokenSchema.parse(req.body);

    // Verify all questions belong to this teacher+institution
    const questions = await prisma.taskQuestion.findMany({
      where: { id: { in: questionIds }, teacherId, institutionId },
      select: { id: true, containerId: true },
    });
    if (questions.length === 0) throw new BadRequestError("No questions found for the given IDs");

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const token = await prisma.questionShareToken.create({
      data: {
        institutionId,
        teacherId,
        sourceContainerId: questions[0].containerId,
        questionIds: questions.map((q) => q.id),
        expiresAt,
      },
    });

    res.status(201).json({ success: true, data: { token: token.id, expiresAt: token.expiresAt } });
  } catch (err) { next(err); }
};

export const getSharedQuestions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    await getTeacherId(userId, institutionId);
    const tokenId = req.params.token as string;

    const token = await prisma.questionShareToken.findFirst({
      where: { id: tokenId, institutionId },
    });
    if (!token) throw new NotFoundError("Share link not found or does not belong to your institution");
    if (token.expiresAt < new Date()) throw new BadRequestError("Share link has expired");

    const questionIds = token.questionIds as string[];
    const questions = await prisma.taskQuestion.findMany({
      where: { id: { in: questionIds }, institutionId },
      orderBy: { createdAt: "asc" },
    });

    res.json({ success: true, data: { questions, expiresAt: token.expiresAt } });
  } catch (err) { next(err); }
};

export const importSharedQuestions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const { token: tokenId, containerId, questionIds } = importQuestionsSchema.parse(req.body);

    const token = await prisma.questionShareToken.findFirst({
      where: { id: tokenId, institutionId },
    });
    if (!token) throw new NotFoundError("Share link not found or does not belong to your institution");
    if (token.expiresAt < new Date()) throw new BadRequestError("Share link has expired");

    const container = await prisma.taskContainer.findFirst({
      where: { id: containerId, teacherId, institutionId },
      select: { id: true, subjectId: true },
    });
    if (!container) throw new NotFoundError("Container not found");

    const allowedIds = new Set(token.questionIds as string[]);
    const toImport = questionIds.filter((id) => allowedIds.has(id));
    if (toImport.length === 0) throw new BadRequestError("None of the selected questions are in this share token");

    const sourceQuestions = await prisma.taskQuestion.findMany({
      where: { id: { in: toImport }, institutionId },
    });

    const importedAt = new Date();
    await prisma.taskQuestion.createMany({
      data: sourceQuestions.map((q) => ({
        institutionId,
        teacherId,
        subjectId: container.subjectId,
        containerId,
        type: q.type,
        status: "PENDING_REVIEW" as const,
        source: "IMPORTED" as const,
        question: q.question,
        questionTemplate: q.questionTemplate ?? undefined,
        options: q.options ?? undefined,
        answer: q.answer,
        details: q.details ? JSON.parse(JSON.stringify(q.details)) : undefined,
        category: q.category ?? undefined,
        createdAt: importedAt,
      })),
    });

    const created = await prisma.taskQuestion.findMany({
      where: { containerId, teacherId, institutionId, source: "IMPORTED", createdAt: { gte: importedAt } },
      include: { moduleAssignment: { select: { moduleId: true, module: { select: { name: true } } } } },
      orderBy: { createdAt: "asc" },
    });

    res.status(201).json({ success: true, data: created });
  } catch (err) { next(err); }
};

// ── Export Question Bank as PDF ───────────────────────────────────────────────
export const exportQuestions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const containerId = req.query.containerId as string;

    if (!containerId) throw new BadRequestError("containerId query param is required");

    const container = await prisma.taskContainer.findFirst({
      where: { id: containerId, teacherId, institutionId },
      select: { id: true, name: true },
    });
    if (!container) throw new NotFoundError("Container not found");

    const questions = await prisma.taskQuestion.findMany({
      where: { containerId, teacherId, institutionId, status: "APPROVED" },
      orderBy: [{ type: "asc" }, { createdAt: "asc" }],
    });

    if (questions.length === 0) throw new BadRequestError("No approved questions to export");

    const teacher = await prisma.teacher.findFirst({
      where: { id: teacherId, institutionId },
      select: { user: { select: { name: true } } },
    });

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${container.name.replace(/\s+/g, "_")}_Question_Bank.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).font("Helvetica-Bold").text(`${container.name} — Question Bank`, { align: "center" });
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

    // "attempts" above counts every attempt row (including ones still in
    // progress). "Submitted" should only reflect attempts the student has
    // actually finished, so tally completed attempts separately and merge
    // them in — same status filter the Results tab uses ("completed").
    const completedCounts = tests.length
      ? await prisma.taskTestAttempt.groupBy({
          by: ["testId"],
          where: { testId: { in: tests.map(t => t.id) }, status: "completed" },
          _count: { _all: true },
        })
      : [];
    const completedMap = new Map(completedCounts.map(c => [c.testId, c._count._all]));
    const testsWithSubmitted = tests.map(t => ({
      ...t,
      _count: { ...t._count, submitted: completedMap.get(t.id) ?? 0 },
    }));

    res.json({ success: true, data: testsWithSubmitted });
  } catch (err) { next(err); }
};

export const createTest = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const data = createTestSchema.parse(req.body);

    const { subjectId } = await resolveSubjectAssignment(teacherId, data.divisionId, institutionId, data.subjectId);

    const testLink = crypto.randomBytes(6).toString("base64url");

    const test = await prisma.taskTest.create({
      data: {
        institutionId, teacherId, subjectId,
        divisionId: data.divisionId,
        title: data.title,
        description: data.description ?? null,
        testLink,
        durationMinutes: data.durationMinutes ?? 60,
        totalMarks: data.totalMarks ?? 100,
        numberOfQuestions: data.numberOfQuestions,
        maxAttempts: data.maxAttempts ?? 1,
        startDate: data.startDate ? new Date(data.startDate) : null,
        validUntil: data.validUntil ? new Date(data.validUntil) : null,
      },
      include: {
        questions: { select: { id: true, isCompulsory: true } },
        _count: { select: { attempts: true } },
      },
    });

    res.status(201).json({ success: true, data: { ...test, _count: { ...test._count, submitted: 0 } } });
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

    const submittedCount = await prisma.taskTestAttempt.count({ where: { testId: test.id, status: "completed" } });

    res.json({ success: true, data: { ...test, _count: { ...test._count, submitted: submittedCount } } });
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
        ...(data.totalMarks !== undefined && { totalMarks: data.totalMarks }),
        ...(data.numberOfQuestions !== undefined && { numberOfQuestions: data.numberOfQuestions }),
        ...(data.maxAttempts !== undefined && { maxAttempts: data.maxAttempts }),
        ...(data.startDate !== undefined && { startDate: data.startDate ? new Date(data.startDate) : null }),
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

    const { title, description, paperType, durationMinutes, maxAttempts, startDate, validUntil, isRandomized, answerSpace, sections, questions, totalMarks } =
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional().nullable(),
        paperType: z.enum(["TEST", "ASSIGNMENT"]).default("TEST"),
        durationMinutes: z.number().int().min(1).max(600).default(60),
        maxAttempts: z.number().int().min(1).max(10).default(1),
        startDate: z.string().optional().nullable(),
        validUntil: z.string().optional().nullable(),
        isRandomized: z.boolean().default(false),
        answerSpace: z.boolean().default(true),
        totalMarks: z.number().int().min(0).max(1000).optional(),
        sections: z.array(z.object({
          id: z.string(),
          title: z.string(),
          instruction: z.string().optional().default(""),
          questionTypes: z.array(z.string()),
          attemptCount: z.number().int().min(0).default(0),
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
          answerSpace,
          sections: sections.length > 0 ? JSON.parse(JSON.stringify(sections)) : null,
          numberOfQuestions: questions.length,
          startDate: startDate ? new Date(startDate) : null,
          validUntil: validUntil ? new Date(validUntil) : null,
          ...(totalMarks !== undefined && { totalMarks }),
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

    const submittedCount = updated ? await prisma.taskTestAttempt.count({ where: { testId: updated.id, status: "completed" } }) : 0;

    res.json({ success: true, data: updated ? { ...updated, _count: { ...updated._count, submitted: submittedCount } } : updated });
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

    const test = await prisma.taskTest.findFirst({
      where: { id, teacherId, institutionId },
      include: { subject: { select: { name: true } }, division: { select: { name: true } } },
    });
    if (!test) throw new NotFoundError("Test not found");

    const attempts = await prisma.taskTestAttempt.findMany({
      where: { testId: id, status: "completed" },
      select: {
        id: true,
        studentName: true,
        rollNo: true,
        attemptNumber: true,
        totalScore: true,
        maxScore: true,
        tabChangeCount: true,
        malpracticeFlag: true,
        startTime: true,
        endTime: true,
        student: { select: { id: true } },
      },
      orderBy: { rollNo: "asc" },
    });

    res.json({ success: true, data: { test, attempts } });
  } catch (err) { next(err); }
};

export const downloadTestResults = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const test = await prisma.taskTest.findFirst({
      where: { id, teacherId, institutionId },
      include: { subject: { select: { name: true } }, division: { select: { name: true } } },
    });
    if (!test) throw new NotFoundError("Test not found");

    const attempts = await prisma.taskTestAttempt.findMany({
      where: { testId: id, status: "completed" },
      select: {
        studentName: true,
        rollNo: true,
        attemptNumber: true,
        totalScore: true,
        maxScore: true,
        tabChangeCount: true,
        malpracticeFlag: true,
        student: { select: { id: true } },
      },
      orderBy: { rollNo: "asc" },
    });

    const rows = attempts.map((a) => ({
      "Roll No": a.rollNo,
      "Student Name": a.studentName,
      "Student ID": a.student?.id ?? "",
      "Class": test.division.name,
      "Exam Title": test.title,
      "Subject": test.subject.name,
      "Attempt": a.attemptNumber,
      "Score": a.totalScore,
      "Max Score": a.maxScore,
      "Percentage": a.maxScore > 0 ? `${Math.round((a.totalScore / a.maxScore) * 100)}%` : "0%",
      "Tab Changes": a.tabChangeCount,
      "Malpractice": a.malpracticeFlag ? "Yes" : "No",
    }));

    const headers = Object.keys(rows[0] ?? {
      "Roll No": "", "Student Name": "", "Student ID": "", "Class": "", "Exam Title": "",
      "Subject": "", "Attempt": "", "Score": "", "Max Score": "", "Percentage": "",
      "Tab Changes": "", "Malpractice": "",
    });

    const csvLines = [
      headers.join(","),
      ...rows.map((row) =>
        headers.map((h) => {
          const val = String((row as Record<string, string | number>)[h] ?? "");
          return val.includes(",") || val.includes('"') || val.includes("\n")
            ? `"${val.replace(/"/g, '""')}"`
            : val;
        }).join(",")
      ),
    ];

    const filename = `${test.title.replace(/[^a-z0-9]/gi, "_")}_results.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csvLines.join("\n"));
  } catch (err) { next(err); }
};

// ── Containers ────────────────────────────────────────────────────────────────
export const listContainers = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const divisionId = req.query.divisionId as string;
    if (!divisionId) throw new BadRequestError("divisionId query param is required");
    const explicitSubjectId = req.query.subjectId as string | undefined;

    const { subjectId } = await resolveSubjectAssignment(teacherId, divisionId, institutionId, explicitSubjectId);

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

    const { subjectId } = await resolveSubjectAssignment(teacherId, data.divisionId, institutionId, data.subjectId);

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
    const explicitSubjectId = req.query.subjectId as string | undefined;

    const { subjectId } = await resolveSubjectAssignment(teacherId, divisionId, institutionId, explicitSubjectId);

    const modules = await prisma.taskModule.findMany({
      where: { teacherId, subjectId, institutionId },
      include: {
        questions: {
          include: {
            question: {
              select: { id: true, type: true, status: true, question: true, options: true, answer: true, createdAt: true, details: true, category: true },
            },
          },
          orderBy: { order: "asc" },
        },
      },
      orderBy: { order: "asc" },
    });

    res.json({ success: true, data: modules });
  } catch (err) { next(err); }
};

export const createModule = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const data = createModuleSchema.parse(req.body);

    const { subjectId } = await resolveSubjectAssignment(teacherId, data.divisionId, institutionId, data.subjectId);

    const existingCount = await prisma.taskModule.count({ where: { teacherId, subjectId, institutionId } });

    const taskModule = await prisma.taskModule.create({
      data: { institutionId, teacherId, subjectId, name: data.name, description: data.description ?? null, order: existingCount },
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

export const reorderModules = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const { modules: items } = reorderModulesSchema.parse(req.body);

    const ids = items.map(i => i.id);
    const owned = await prisma.taskModule.findMany({ where: { id: { in: ids }, teacherId, institutionId }, select: { id: true } });
    if (owned.length !== ids.length) throw new NotFoundError("One or more modules not found");

    await prisma.$transaction(items.map(i => prisma.taskModule.update({ where: { id: i.id }, data: { order: i.order } })));

    res.json({ success: true });
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

    const existingCount = await prisma.taskModuleQuestion.count({ where: { moduleId } });
    const assignment = await prisma.taskModuleQuestion.create({ data: { moduleId, questionId, order: existingCount } });

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

export const reorderModuleQuestions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const moduleId = req.params.id as string;
    const { questions: items } = reorderModuleQuestionsSchema.parse(req.body);

    const taskModule = await prisma.taskModule.findFirst({ where: { id: moduleId, teacherId, institutionId } });
    if (!taskModule) throw new NotFoundError("Module not found");

    const questionIds = items.map(i => i.questionId);
    const owned = await prisma.taskModuleQuestion.findMany({ where: { questionId: { in: questionIds }, moduleId }, select: { questionId: true } });
    if (owned.length !== questionIds.length) throw new NotFoundError("One or more questions not found in this module");

    await prisma.$transaction(items.map(i => prisma.taskModuleQuestion.update({ where: { questionId: i.questionId }, data: { order: i.order } })));

    res.json({ success: true });
  } catch (err) { next(err); }
};

// Creates a question directly inside a module without requiring the teacher to pick a container.
// Finds or auto-creates a "Manual Questions" container for the teacher's subject+division.
export const createModuleQuestion = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const moduleId = req.params.id as string;

    const taskModule = await prisma.taskModule.findFirst({
      where: { id: moduleId, teacherId, institutionId },
      select: { id: true, subjectId: true },
    });
    if (!taskModule) throw new NotFoundError("Module not found");

    // Parse question fields (reuse createManualQuestionSchema minus containerId)
    const data = createManualQuestionSchema
      .omit({ containerId: true })
      .parse(req.body);

    if ((data.type === "MCQ" || data.type === "CONCEPTUAL") && (!data.options || data.options.length !== 4))
      throw new BadRequestError("MCQ/Conceptual questions require exactly 4 options");
    if ((data.type === "MCQ" || data.type === "CONCEPTUAL") && !data.options!.includes(data.answer))
      throw new BadRequestError("Answer must be one of the provided options");
    if (data.type === "TRUE_FALSE" && !["true", "false"].includes(data.answer.toLowerCase()))
      throw new BadRequestError("True/False answer must be 'true' or 'false'");
    if (data.type === "NUMERICAL" && isNaN(Number(data.answer)))
      throw new BadRequestError("Numerical answer must be a valid number");

    // Find or create a "Manual Questions" container for this teacher+subject
    let container = await prisma.taskContainer.findFirst({
      where: { teacherId, subjectId: taskModule.subjectId, institutionId, name: "Manual Questions" },
      select: { id: true },
    });
    if (!container) {
      // Need divisionId for container — find any division this teacher+subject is assigned to
      const assignment = await prisma.divisionAssignment.findFirst({
        where: { teacherId, subjectId: taskModule.subjectId, institutionId },
        select: { divisionId: true },
      });
      if (!assignment) throw new NotFoundError("No division assignment found for this subject");
      container = await prisma.taskContainer.create({
        data: {
          institutionId, teacherId,
          subjectId: taskModule.subjectId,
          divisionId: assignment.divisionId,
          name: "Manual Questions",
        },
        select: { id: true },
      });
    }

    let details: Record<string, unknown> | null = null;
    if (data.type === "CONCEPTUAL" && data.options) {
      details = { correct_answer: data.answer, distractors: data.options.filter((o) => o !== data.answer) };
    } else if (data.type === "NUMERICAL") {
      details = { correct_answer_formula: data.formula || data.answer, variables: {} };
    }

    const question = await prisma.taskQuestion.create({
      data: {
        institutionId, teacherId,
        subjectId: taskModule.subjectId,
        containerId: container.id,
        type: data.type, status: "APPROVED", source: "MANUAL",
        question: data.question,
        ...(data.type === "NUMERICAL" ? { questionTemplate: data.question } : {}),
        answer: data.answer,
        options: data.type === "MCQ" ? (data.options as string[]) : undefined,
        details: details ? JSON.parse(JSON.stringify(details)) : undefined,
        category: data.category ?? undefined,
      },
    });

    const existing = await prisma.taskModuleQuestion.findUnique({ where: { questionId: question.id } });
    if (existing) throw new BadRequestError("Question already assigned to a module");

    const existingCount = await prisma.taskModuleQuestion.count({ where: { moduleId } });
    const assignment = await prisma.taskModuleQuestion.create({
      data: { moduleId, questionId: question.id, order: existingCount },
    });

    res.status(201).json({
      success: true,
      data: {
        id: assignment.id,
        questionId: question.id,
        assignedAt: assignment.assignedAt,
        question: {
          id: question.id, type: question.type, status: question.status,
          question: question.question, options: question.options, answer: question.answer,
          createdAt: question.createdAt, details: question.details, category: question.category,
        },
      },
    });
  } catch (err) { next(err); }
};

// ── Assignments ───────────────────────────────────────────────────────────────
export const listAssignments = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const divisionId = req.query.divisionId as string;
    if (!divisionId) throw new BadRequestError("divisionId query param is required");
    const explicitSubjectId = req.query.subjectId as string | undefined;

    const { subjectId } = await resolveSubjectAssignment(teacherId, divisionId, institutionId, explicitSubjectId);

    const assignments = await prisma.taskAssignment.findMany({
      where: { teacherId, divisionId, subjectId, institutionId },
      orderBy: { createdAt: "desc" },
    });

    const data = assignments.map((a) => ({
      ...a,
      _count: { submissions: 0 },
    }));

    res.json({ success: true, data });
  } catch (err) { next(err); }
};

export const createAssignment = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const data = createAssignmentSchema.parse(req.body);

    const { subjectId } = await resolveSubjectAssignment(teacherId, data.divisionId, institutionId, data.subjectId);

    const assignment = await prisma.taskAssignment.create({
      data: {
        institutionId, teacherId, subjectId,
        divisionId: data.divisionId,
        title: data.title,
        description: data.description ?? null,
        totalMarks: data.totalMarks ?? 10,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        submissionType: data.submissionType ?? "OFFLINE",
      },
    });

    res.status(201).json({ success: true, data: { ...assignment, _count: { submissions: 0 } } });
  } catch (err) { next(err); }
};

export const updateAssignment = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;
    const data = updateAssignmentSchema.parse(req.body);

    const existing = await prisma.taskAssignment.findFirst({ where: { id, teacherId, institutionId } });
    if (!existing) throw new NotFoundError("Assignment not found");

    const updated = await prisma.taskAssignment.update({
      where: { id },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.totalMarks !== undefined && { totalMarks: data.totalMarks }),
        ...(data.dueDate !== undefined && { dueDate: data.dueDate ? new Date(data.dueDate) : null }),
        ...(data.submissionType !== undefined && { submissionType: data.submissionType }),
        ...(data.status !== undefined && { status: data.status }),
      },
    });

    res.json({ success: true, data: { ...updated, _count: { submissions: 0 } } });
  } catch (err) { next(err); }
};

export const deleteAssignment = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const existing = await prisma.taskAssignment.findFirst({ where: { id, teacherId, institutionId } });
    if (!existing) throw new NotFoundError("Assignment not found");

    await prisma.taskAssignment.deleteMany({ where: { id, teacherId, institutionId } });

    res.json({ success: true });
  } catch (err) { next(err); }
};

export const getAssignment = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const assignment = await prisma.taskAssignment.findFirst({ where: { id, teacherId, institutionId } });
    if (!assignment) throw new NotFoundError("Assignment not found");

    type StoredQ = { questionId: string; sectionId: string | null; marks: number; order: number; isCompulsory: boolean };
    const storedQs = (assignment.questions as StoredQ[] | null) ?? [];
    const questionIds = storedQs.map(q => q.questionId);

    const questionObjects = questionIds.length > 0
      ? await prisma.taskQuestion.findMany({
          where: { id: { in: questionIds }, teacherId, institutionId },
          select: { id: true, type: true, status: true, question: true, questionTemplate: true, answer: true, options: true, details: true, category: true },
        })
      : [];

    const qMap = new Map(questionObjects.map(q => [q.id, q]));
    const questions = storedQs
      .map(sq => {
        const q = qMap.get(sq.questionId);
        if (!q) return null;
        return { question: q, sectionId: sq.sectionId, marks: sq.marks, order: sq.order, isCompulsory: sq.isCompulsory };
      })
      .filter(Boolean)
      .sort((a, b) => ((a as { order: number }).order ?? 0) - ((b as { order: number }).order ?? 0));

    res.json({
      success: true,
      data: {
        ...assignment,
        questions,
        paperType: "ASSIGNMENT",
        durationMinutes: 60,
        maxAttempts: 1,
        validUntil: null,
        testLink: null,
        _count: { attempts: 0 },
      },
    });
  } catch (err) { next(err); }
};

// ── Assignment Submission Management (Teacher) ────────────────────────────────

export const getAssignmentSubmissions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const assignment = await prisma.taskAssignment.findFirst({
      where: { id, teacherId, institutionId },
      select: { id: true, title: true, submissionType: true, divisionId: true, dueDate: true, totalMarks: true },
    });
    if (!assignment) throw new NotFoundError("Assignment not found");

    // Get all students in the division
    const students = await prisma.student.findMany({
      where: { divisionId: assignment.divisionId, institutionId },
      select: { id: true, rollNo: true, user: { select: { name: true } } },
      orderBy: { rollNo: "asc" },
    });

    // Get all submissions for this assignment
    const submissions = await prisma.taskAssignmentSubmission.findMany({
      where: { assignmentId: id, institutionId },
    });

    const subMap = new Map(submissions.map(s => [s.studentId, s]));

    const data = students.map(student => {
      const sub = subMap.get(student.id) ?? null;
      return {
        student: { id: student.id, name: student.user.name, rollNo: student.rollNo },
        submission: sub,
      };
    });

    res.json({ success: true, data: { assignment, students: data } });
  } catch (err) { next(err); }
};

export const reviewSubmission = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const assignmentId = req.params.id as string;
    const studentId = req.params.studentId as string;

    const { reviewStatus, reviewNote } = z.object({
      reviewStatus: z.enum(["CORRECT", "WRITE_AGAIN"]),
      reviewNote: z.string().max(500).trim().optional().nullable(),
    }).parse(req.body);

    const assignment = await prisma.taskAssignment.findFirst({
      where: { id: assignmentId, teacherId, institutionId },
    });
    if (!assignment) throw new NotFoundError("Assignment not found");
    if (assignment.submissionType !== "ONLINE") throw new BadRequestError("This assignment is OFFLINE-only");

    const submission = await prisma.taskAssignmentSubmission.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId } },
    });
    if (!submission) throw new NotFoundError("No submission found for this student");
    if (!submission.submittedAt) throw new BadRequestError("Student has not submitted yet");

    const updated = await prisma.taskAssignmentSubmission.update({
      where: { assignmentId_studentId: { assignmentId, studentId } },
      data: {
        reviewStatus,
        reviewNote: reviewNote ?? null,
        reviewedAt: new Date(),
        reviewedByTeacherId: teacherId,
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

export const markOfflineSubmission = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const assignmentId = req.params.id as string;
    const studentId = req.params.studentId as string;

    const { submitted } = z.object({
      submitted: z.boolean(),
    }).parse(req.body);

    const assignment = await prisma.taskAssignment.findFirst({
      where: { id: assignmentId, teacherId, institutionId },
    });
    if (!assignment) throw new NotFoundError("Assignment not found");

    // Upsert submission record — preserve existing offlineSubmittedAt if already set
    const existing = await prisma.taskAssignmentSubmission.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId } },
      select: { offlineSubmittedAt: true },
    });
    const offlineTimestamp = submitted
      ? (existing?.offlineSubmittedAt ?? new Date())
      : null;

    const updated = await prisma.taskAssignmentSubmission.upsert({
      where: { assignmentId_studentId: { assignmentId, studentId } },
      create: {
        assignmentId,
        studentId,
        institutionId,
        offlineSubmittedAt: offlineTimestamp,
        offlineMarkedByTeacherId: submitted ? teacherId : null,
      },
      update: {
        offlineSubmittedAt: offlineTimestamp,
        offlineMarkedByTeacherId: submitted ? teacherId : null,
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

export const saveAssignmentPaper = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const { title, description, isRandomized, answerSpace, sections, questions, totalMarks } = z.object({
      title: z.string().min(1).max(200),
      description: z.string().max(1000).optional().nullable(),
      isRandomized: z.boolean().default(false),
      answerSpace: z.boolean().default(true),
      totalMarks: z.number().int().min(0).max(1000).optional(),
      sections: z.array(z.object({
        id: z.string(),
        title: z.string(),
        instruction: z.string().optional().default(""),
        questionTypes: z.array(z.string()),
        attemptCount: z.number().int().min(0).default(0),
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

    const assignment = await prisma.taskAssignment.findFirst({ where: { id, teacherId, institutionId } });
    if (!assignment) throw new NotFoundError("Assignment not found");

    if (questions.length > 0) {
      const qIds = questions.map(q => q.questionId);
      const validQs = await prisma.taskQuestion.findMany({
        where: { id: { in: qIds }, teacherId, institutionId, status: "APPROVED" },
        select: { id: true },
      });
      if (validQs.length !== qIds.length) throw new BadRequestError("One or more questions not found or not approved");
    }

    await prisma.taskAssignment.update({
      where: { id },
      data: {
        title,
        description: description ?? null,
        isRandomized,
        answerSpace,
        sections: sections.length > 0 ? JSON.parse(JSON.stringify(sections)) : null,
        questions: JSON.parse(JSON.stringify(questions)),
        numberOfQuestions: questions.length,
        ...(totalMarks !== undefined && { totalMarks }),
      },
    });

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
        durationMinutes: true, totalMarks: true, numberOfQuestions: true,
        maxAttempts: true, startDate: true, validUntil: true, testLink: true, divisionId: true,
        institutionId: true,
      },
    });

    if (!test) throw new NotFoundError("Test not found");
    if (test.status === "DRAFT") throw new BadRequestError("This test is not yet active");
    // A test activated with "Start at <scheduled time>" is ACTIVE in status but must stay
    // inaccessible until that moment — this closes the gap where a student with the direct
    // link could start early even though the list correctly shows it as "Upcoming".
    if (test.startDate && new Date(test.startDate) > new Date())
      throw new BadRequestError("This test hasn't started yet");
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
        total_marks: test.totalMarks,
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
    if (test.startDate && new Date(test.startDate) > new Date())
      throw new BadRequestError("This test hasn't started yet");
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
        maxScore: test.totalMarks,
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
        totalMarks: test.totalMarks,
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
      total_marks: test.totalMarks,
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

    // Score each answer — uniform distribution of totalMarks across all questions
    const scorePerQuestion = storedAnswers.length > 0 ? test.totalMarks / storedAnswers.length : 0;
    let totalScore = 0;
    const updates: Array<{ id: string; studentAnswer: string; isCorrect: boolean }> = [];

    for (const submitted of answers) {
      const stored = storedAnswers.find(sa => sa.questionId === submitted.questionId);
      if (!stored) continue;

      const isCorrect = submitted.answer?.trim().toLowerCase() === stored.correctAnswer.trim().toLowerCase();
      if (isCorrect) totalScore += scorePerQuestion;

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
        test: { select: { title: true, totalMarks: true } },
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
        test: { select: { title: true, totalMarks: true } },
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
        total_marks: attempt.test.totalMarks,
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
