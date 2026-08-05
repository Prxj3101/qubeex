import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { uploadAttachmentToR2, scheduleR2FileDeletion, r2KeyFromUrl } from "../../services/storage.service";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { createFolderSchema, aiScanSchema, aiChatSchema, aiQuizSchema } from "./blackboard.schema";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");
import { redis, isRedisReady } from "../../utils/redis";

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

async function checkTokenPool(institutionId: string): Promise<void> {
  if (!openai) return;
  if (!redis || !isRedisReady) {
    if (redis) console.warn("[blackboard] Redis configured but not ready — token pool check skipped");
    return;
  }
  const usageKey = `ai:usage:institution:${institutionId}`;
  const limitKey = `ai:limit:institution:${institutionId}`;
  const [used, limit] = await Promise.all([redis.get(usageKey), redis.get(limitKey)]);
  const usedN = Number(used ?? 0);
  const limitN = Number(limit ?? 0);
  if (limitN > 0 && usedN >= limitN) {
    throw Object.assign(new Error("Token limit reached"), { statusCode: 429 });
  }
}

async function deductTokens(institutionId: string, tokens: number, teacherId?: string): Promise<void> {
  if (!redis || !isRedisReady || tokens <= 0) return;
  await redis.incrby(`ai:usage:institution:${institutionId}`, tokens).catch(() => {});
  if (teacherId) await redis.incrby(`ai:usage:teacher:${teacherId}`, tokens).catch(() => {});
}

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const ALLOWED_MIMETYPES = new Set([
  "application/pdf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function requireTeacher(req: AuthRequest) {
  const { institutionId, userId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return { institutionId, userId };
}

async function getTeacherId(userId: string, institutionId: string): Promise<string> {
  const teacher = await prisma.teacher.findFirst({ where: { userId, institutionId }, select: { id: true } });
  if (!teacher) throw new BadRequestError("Teacher profile not found");
  return teacher.id;
}

// ── Storage: Folders ──────────────────────────────────────────────────────────

export const listFolders = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);

    const [folders, files] = await Promise.all([
      prisma.blackboardFolder.findMany({
        where: { teacherId, institutionId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, parentId: true, createdAt: true },
      }),
      prisma.blackboardMaterial.findMany({
        where: { teacherId, institutionId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, fileUrl: true, mimeType: true, size: true, folderId: true, createdAt: true },
      }),
    ]);

    // Build tree in-memory
    type FolderNode = {
      id: string; name: string; parentId: string | null; createdAt: Date;
      children: FolderNode[];
      files: typeof files;
    };
    const map = new Map<string, FolderNode>();
    for (const f of folders) map.set(f.id, { ...f, children: [], files: [] });
    for (const file of files) {
      const folder = map.get(file.folderId);
      if (folder) folder.files.push(file);
    }
    const roots: FolderNode[] = [];
    for (const f of map.values()) {
      if (!f.parentId) { roots.push(f); }
      else { map.get(f.parentId)?.children.push(f); }
    }

    res.json({ success: true, data: roots });
  } catch (err) { next(err); }
};

export const createFolder = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const data = createFolderSchema.parse(req.body);

    if (data.parentId) {
      const parent = await prisma.blackboardFolder.findFirst({
        where: { id: data.parentId, teacherId, institutionId },
      });
      if (!parent) throw new NotFoundError("Parent folder not found");
    }

    const folder = await prisma.blackboardFolder.create({
      data: { institutionId, teacherId, name: data.name, parentId: data.parentId ?? null },
      select: { id: true, name: true, parentId: true, createdAt: true },
    });

    res.status(201).json({ success: true, data: { ...folder, children: [], files: [] } });
  } catch (err) { next(err); }
};

export const deleteFolder = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const folderId = req.params.id as string;

    const folder = await prisma.blackboardFolder.findFirst({ where: { id: folderId, teacherId, institutionId } });
    if (!folder) throw new NotFoundError("Folder not found");

    // Collect all descendant folder IDs (BFS)
    const allFolderIds: string[] = [folderId];
    const queue = [folderId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = await prisma.blackboardFolder.findMany({
        where: { parentId: current, teacherId, institutionId },
        select: { id: true },
      });
      for (const c of children) { allFolderIds.push(c.id); queue.push(c.id); }
    }

    // Collect all r2Keys for files in these folders
    const files = await prisma.blackboardMaterial.findMany({
      where: { folderId: { in: allFolderIds }, institutionId },
      select: { r2Key: true },
    });

    // Delete folders (deepest first to avoid FK issues — children cascade deletes files)
    for (let i = allFolderIds.length - 1; i >= 0; i--) {
      await prisma.blackboardFolder.delete({ where: { id: allFolderIds[i] } });
    }

    // Schedule R2 deletions
    for (const f of files) {
      await scheduleR2FileDeletion(f.r2Key).catch((e) => console.error("[blackboard deleteFolder] Failed to schedule R2 deletion:", e));
    }

    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── Storage: Files ────────────────────────────────────────────────────────────

export const uploadFile = async (
  req: AuthRequest & { file?: Express.Multer.File },
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const folderId = req.params.id as string;

    const folder = await prisma.blackboardFolder.findFirst({ where: { id: folderId, teacherId, institutionId } });
    if (!folder) throw new NotFoundError("Folder not found");

    const file = req.file;
    if (!file) throw new BadRequestError("No file provided");
    if (!ALLOWED_MIMETYPES.has(file.mimetype)) {
      throw new BadRequestError("File type not allowed. Accepted: PDF, PPT, PPTX, DOC, DOCX");
    }

    const result = await uploadAttachmentToR2(file.buffer, {
      originalName: file.originalname,
      contentType: file.mimetype,
      institutionId,
      area: "blackboard",
    });

    const r2Key = r2KeyFromUrl(result.publicUrl);
    if (!r2Key) throw new BadRequestError("R2 key extraction failed — check R2_PUBLIC_URL configuration");

    const material = await prisma.blackboardMaterial.create({
      data: {
        institutionId,
        teacherId,
        folderId,
        name: file.originalname,
        fileUrl: result.publicUrl,
        r2Key,
        mimeType: file.mimetype,
        size: file.size,
      },
      select: { id: true, name: true, fileUrl: true, mimeType: true, size: true, folderId: true, createdAt: true },
    });

    res.status(201).json({ success: true, data: material });
  } catch (err) { next(err); }
};

export const deleteFile = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const fileId = req.params.id as string;

    const file = await prisma.blackboardMaterial.findFirst({ where: { id: fileId, teacherId, institutionId } });
    if (!file) throw new NotFoundError("File not found");

    await prisma.blackboardMaterial.delete({ where: { id: fileId } });
    await scheduleR2FileDeletion(file.r2Key).catch(() => {});

    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── Images ────────────────────────────────────────────────────────────────────

async function fetchWikimediaImages(query: string, limit = 4): Promise<{ url: string; caption: string }[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: query,
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    format: "json",
    gsrlimit: String(Math.min(limit * 2, 12)),
    origin: "*",
  });

  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return [];

  const json = await response.json() as {
    query?: {
      pages?: Record<string, {
        title: string;
        imageinfo?: Array<{ url: string; extmetadata?: { ImageDescription?: { value: string } } }>;
      }>;
    };
  };

  const pages = Object.values(json.query?.pages ?? {});
  const IMAGE_EXT = /\.(jpg|jpeg|png|svg|gif|webp)$/i;

  const results: { url: string; caption: string }[] = [];
  for (const page of pages) {
    if (results.length >= limit) break;
    const info = page.imageinfo?.[0];
    if (!info?.url || !IMAGE_EXT.test(info.url)) continue;
    const rawCaption = info.extmetadata?.ImageDescription?.value ?? "";
    const caption = rawCaption.replace(/<[^>]*>/g, "").trim() || page.title.replace("File:", "").replace(/\.[^.]+$/, "");
    results.push({ url: info.url, caption });
  }

  return results;
}

// ── AI ────────────────────────────────────────────────────────────────────────

const MOCK_SCAN = {
  topic: "Photosynthesis",
  overview: "Photosynthesis is the process by which green plants convert sunlight into food using carbon dioxide and water, producing oxygen as a byproduct.",
  keyPoints: [
    "Occurs in chloroplasts inside plant cells",
    "Requires sunlight, CO₂, and water as inputs",
    "Produces glucose (food) and oxygen as outputs",
    "Has two stages: Light-dependent reactions and the Calvin cycle",
    "Chlorophyll is the primary pigment that absorbs light",
  ],
  images: [
    { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Photosynthesis.gif/220px-Photosynthesis.gif", caption: "Photosynthesis Process" },
    { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/49/Chloroplast_mini.svg/220px-Chloroplast_mini.svg.png", caption: "Chloroplast Structure" },
  ],
};

export const aiScan = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const data = aiScanSchema.parse(req.body);

    if (!openai) {
      return res.json({ success: true, data: MOCK_SCAN });
    }

    await checkTokenPool(institutionId);
    const teacherId = await getTeacherId(userId, institutionId);

    const systemPrompt = "You are a knowledgeable teacher's assistant. Given a topic, return a JSON object with: topic (string), overview (1-2 sentence summary), keyPoints (array of 4-6 concise bullet strings). Return ONLY valid JSON, no markdown.";
    const userContent = data.pageText
      ? `Topic: ${data.topic}\n\nPage content for context:\n${data.pageText}`
      : `Topic: ${data.topic}`;

    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      max_tokens: 600,
    });

    await deductTokens(institutionId, completion.usage?.total_tokens ?? 0, teacherId);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(completion.choices[0].message.content ?? "{}");
    } catch {
      throw new BadRequestError("AI returned malformed JSON — please retry");
    }
    const images = await fetchWikimediaImages(data.topic, 3);

    res.json({ success: true, data: { ...parsed, images } });
  } catch (err) { next(err); }
};

const MOCK_CHAT_REPLY = "I'm your AI teaching assistant. Once connected to OpenAI, I'll be able to answer detailed questions about your current lesson topic, provide examples, and help clarify concepts for your students.";

export const aiChat = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const data = aiChatSchema.parse(req.body);

    if (!openai) {
      return res.json({ success: true, data: { reply: MOCK_CHAT_REPLY } });
    }

    await checkTokenPool(institutionId);
    const teacherId = await getTeacherId(userId, institutionId);

    const systemContent = data.context
      ? `You are a classroom teaching assistant helping a teacher explain concepts clearly. Current lesson context: ${data.context}. Keep answers concise and classroom-appropriate.`
      : "You are a classroom teaching assistant. Answer clearly and concisely. Focus on educational accuracy.";

    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: systemContent },
        ...data.messages,
      ],
      max_tokens: 500,
    });

    await deductTokens(institutionId, completion.usage?.total_tokens ?? 0, teacherId);

    res.json({ success: true, data: { reply: completion.choices[0].message.content ?? "" } });
  } catch (err) { next(err); }
};

const MOCK_QUIZ = [
  { id: "q1", question: "Where does photosynthesis primarily occur?", options: ["Mitochondria", "Chloroplast", "Nucleus", "Ribosome"], answer: 1 },
  { id: "q2", question: "What gas is released as a byproduct of photosynthesis?", options: ["Carbon Dioxide", "Nitrogen", "Oxygen", "Hydrogen"], answer: 2 },
  { id: "q3", question: "What is the primary light-absorbing pigment in plants?", options: ["Carotenoid", "Xanthophyll", "Chlorophyll", "Anthocyanin"], answer: 2 },
  { id: "q4", question: "Which light wavelengths are most effective for photosynthesis?", options: ["Green only", "Yellow only", "Red and Blue", "White light only"], answer: 2 },
  { id: "q5", question: "What is the direct energy product of photosynthesis?", options: ["Protein", "Glucose", "Starch", "Fat"], answer: 1 },
];

export const aiQuiz = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const data = aiQuizSchema.parse(req.body);

    if (!openai) {
      return res.json({ success: true, data: { questions: MOCK_QUIZ.slice(0, data.count) } });
    }

    await checkTokenPool(institutionId);
    const teacherId = await getTeacherId(userId, institutionId);

    const systemPrompt = `You are a quiz generator for classroom teachers. Generate exactly ${data.count} multiple-choice questions at ${data.difficulty} difficulty. Return a JSON object with a "questions" array. Each question: { "id": "q1", "question": "...", "options": ["A", "B", "C", "D"], "answer": <0-indexed correct option number> }. Return ONLY valid JSON, no markdown.`;
    const userContent = data.pageText
      ? `Topic: ${data.topic}\n\nBase the questions on this content:\n${data.pageText}`
      : `Topic: ${data.topic}`;

    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1200,
    });

    await deductTokens(institutionId, completion.usage?.total_tokens ?? 0, teacherId);

    let parsed: { questions?: { id?: string; question: string; options: string[]; answer: number }[] };
    try {
      parsed = JSON.parse(completion.choices[0].message.content ?? '{"questions":[]}');
    } catch {
      throw new BadRequestError("AI returned malformed JSON — please retry");
    }
    const questions = (parsed.questions ?? []).map((q: { id?: string; question: string; options: string[]; answer: number }, i: number) => ({
      id: q.id ?? `q${i + 1}`,
      question: q.question,
      options: q.options,
      answer: q.answer,
    }));

    res.json({ success: true, data: { questions } });
  } catch (err) { next(err); }
};

export const searchImages = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = (req.query.q as string ?? "").trim();
    if (!q || q.length < 2) throw new BadRequestError("Query must be at least 2 characters");

    const images = await fetchWikimediaImages(q, 4);
    res.json({ success: true, data: images });
  } catch (err) { next(err); }
};

