import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { uploadAttachmentToR2, scheduleR2FileDeletion, r2KeyFromUrl } from "../../services/storage.service";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { createFolderSchema, aiScanSchema, aiChatSchema, aiQuizSchema } from "./blackboard.schema";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");
import { redis, isRedisReady } from "../../utils/redis";
import { getAiTokenLimit } from "../../services/billing.service";

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
  const [used, limitN] = await Promise.all([redis.get(usageKey), getAiTokenLimit(institutionId)]);
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

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "onto", "about",
  "diagram", "image", "photo", "picture", "illustration", "process", "example",
]);

function keywordsOf(text: string): string[] {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !STOPWORDS.has(w));
  // Prefer longer, less ambiguous words (e.g. reject "dfs" in favor of
  // "distributed"/"file"/"system" when both are available in the same text),
  // but fall back to the short ones rather than silently producing an empty
  // keyword list — an empty list disables relevance filtering entirely,
  // which is worse than filtering on an imperfect short word/acronym.
  const long = words.filter(w => w.length >= 4);
  return [...new Set(long.length > 0 ? long : words)];
}

// Whole-word containment, not substring — plain `.includes()` would let
// "file" match inside "profile", "filed", "filet", etc., which in practice
// let completely unrelated Commons results (photos whose description
// happened to mention a historical "profile") through the relevance filter.
// Keywords only ever contain [a-z0-9] (see keywordsOf's split), so no regex
// escaping is needed here.
function haystackContainsWord(haystack: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, "i").test(haystack);
}

async function fetchWikimediaImages(
  query: string,
  limit = 4,
  relevanceKeywords?: string[]
): Promise<{ url: string; caption: string }[]> {
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

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, {
      // Wikimedia's API etiquette requires a descriptive User-Agent identifying
      // the client — requests without one can be throttled/blocked depending
      // on the calling IP, even though the API itself doesn't require auth.
      headers: { "User-Agent": "QubeEx-Blackboard/1.0 (https://qubeex.app; contact@qubeex.app) node-fetch" },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("[blackboard] Wikimedia image search request failed:", err);
    return [];
  }
  if (!response.ok) {
    console.error(`[blackboard] Wikimedia image search returned ${response.status} for query "${query}"`);
    return [];
  }

  const json = await response.json() as {
    query?: {
      pages?: Record<string, {
        title: string;
        imageinfo?: Array<{ url: string; extmetadata?: { ImageDescription?: { value: string } } }>;
      }>;
    };
  };

  const pages = Object.values(json.query?.pages ?? {});
  // Wikimedia now appends tracking params to imageinfo URLs (e.g.
  // "...svg?utm_source=..."), so the extension is no longer the literal end
  // of the string — match it before an optional query string instead of
  // anchoring to `$`, or this rejects every single result.
  const IMAGE_EXT = /\.(jpg|jpeg|png|svg|gif|webp)(?:\?.*)?$/i;

  // Commons' full-text search ranks by relevance across title/description/
  // categories, but for multi-word queries it can still return loosely-
  // related top hits. Require the result's own title/caption to contain ALL
  // of the meaningful keywords, not just any one of them — Commons file
  // descriptions almost universally use generic words like "file" or
  // "system" self-referentially ("this file depicts...") regardless of
  // subject matter, so requiring just one match let completely unrelated
  // results (e.g. a maze-generation image, because its description mentions
  // "file") through. Requiring every keyword to co-occur is far more precise
  // for multi-word topics, and degrades gracefully to the same behavior as
  // before for single-keyword topics.
  const queryKeywords = relevanceKeywords ?? keywordsOf(query);

  const results: { url: string; caption: string }[] = [];
  for (const page of pages) {
    if (results.length >= limit) break;
    const info = page.imageinfo?.[0];
    if (!info?.url || !IMAGE_EXT.test(info.url)) continue;
    const rawCaption = info.extmetadata?.ImageDescription?.value ?? "";
    const cleanTitle = page.title.replace(/^File:/i, "").replace(/\.[^.]+$/, "");
    const caption = rawCaption.replace(/<[^>]*>/g, "").trim() || cleanTitle;
    if (queryKeywords.length > 0) {
      // Match against the title/caption with the "File:" namespace prefix and
      // file extension stripped — every single Commons result's raw title
      // starts with "File:", so leaving it in would let it collide with any
      // query that happens to contain the word "file" (e.g. "Distributed
      // File System"), matching every result regardless of real relevance.
      const haystack = `${cleanTitle} ${caption}`.toLowerCase();
      if (!queryKeywords.every(k => haystackContainsWord(haystack, k))) continue;
    }
    results.push({ url: info.url, caption });
  }

  return results;
}

const WIKI_USER_AGENT = "QubeEx-Blackboard/1.0 (https://qubeex.app; contact@qubeex.app) node-fetch";

// Look up the actual Wikipedia article for a topic and return its curated
// lead image, instead of full-text searching Commons for files that merely
// mention matching words somewhere in their metadata. Wikipedia's REST
// summary endpoint resolves redirects/disambiguation automatically (so
// "DFS" → "Distributed file system" article works if that's the real title),
// and the lead image is manually chosen by editors to represent that exact
// article's subject — precise by construction, not by keyword filtering.
// Free, same WMF infrastructure, no API key.
async function fetchWikipediaSummary(title: string): Promise<{ url: string; caption: string } | null> {
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
      headers: { "User-Agent": WIKI_USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json() as {
      type?: string;
      title?: string;
      thumbnail?: { source: string };
      originalimage?: { source: string };
    };
    // Disambiguation pages ("DFS (disambiguation)") have no single subject —
    // treat as no match rather than showing an arbitrary/unrelated image.
    if (json.type === "disambiguation") return null;
    const url = json.thumbnail?.source ?? json.originalimage?.source;
    if (!url) return null;
    return { url, caption: json.title ?? title };
  } catch (err) {
    console.error(`[blackboard] Wikipedia summary lookup failed for "${title}":`, err);
    return null;
  }
}

// If there's no article at the exact title (no direct redirect either),
// find the closest real article title via Wikipedia's own search/suggestion
// index, then retry — still an exact article lookup once resolved, just with
// one extra hop to find which article that is.
async function resolveWikipediaTitle(query: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&namespace=0&limit=1&search=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": WIKI_USER_AGENT }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const json = await res.json() as [string, string[], string[], string[]];
    return json[1]?.[0] ?? null;
  } catch (err) {
    console.error(`[blackboard] Wikipedia title resolution failed for "${query}":`, err);
    return null;
  }
}

// Beyond the single curated lead image, pull additional images actually
// embedded in the article body — Wikipedia articles commonly have several
// (diagrams, photos, charts), not just the one page thumbnail. Deliberately
// using the REST "media-list" endpoint here rather than the `generator=images`
// action API: that action API returns an article's images in roughly
// alphabetical-by-filename order, which has no relationship to relevance —
// a tangential portrait or an unrelated flag can easily sort ahead of the
// actual topic diagrams. media-list instead returns items in the order they
// actually appear in the article, so the lead/intro-section diagrams
// consistently come first and later, less-central images (e.g. a portrait of
// a historical figure mentioned in a "History" section) sort accordingly late.
const WIKI_CHROME_FILENAME_PATTERN = /(protection-shackle|padlock|edit-icon|question_book|commons-logo|wiktionary-logo|wikiquote-logo|wikisource-logo|wikinews-logo|wikispecies-logo|wikiversity-logo|wikivoyage-logo|wikidata-logo|ambox|disambig_gray|red_pog|ooui_)/i;

async function fetchArticleEmbeddedImages(
  title: string,
  limit: number,
  exclude: Set<string>
): Promise<{ url: string; caption: string }[]> {
  if (limit <= 0) return [];
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/media-list/${encodeURIComponent(title)}`, {
      headers: { "User-Agent": WIKI_USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];

    const json = await res.json() as {
      items?: Array<{
        title: string;
        type: string;
        leadImage?: boolean;
        caption?: { text?: string };
        srcset?: Array<{ src: string; scale: string }>;
      }>;
    };
    const items = json.items ?? [];
    const IMAGE_EXT = /\.(jpg|jpeg|png|svg|gif|webp)(?:\?.*)?$/i;

    const results: { url: string; caption: string }[] = [];
    for (const item of items) {
      if (results.length >= limit) break;
      // The lead image is already fetched separately (as the curated
      // thumbnail from the page summary) — skip it here to avoid a duplicate.
      if (item.leadImage) continue;
      if (item.type !== "image") continue;
      if (WIKI_CHROME_FILENAME_PATTERN.test(item.title)) continue;
      const src = item.srcset?.[0]?.src;
      if (!src || !IMAGE_EXT.test(src)) continue;
      const url = src.startsWith("//") ? `https:${src}` : src;
      if (exclude.has(url)) continue;
      const cleanTitle = item.title.replace(/^File:/i, "").replace(/_/g, " ").replace(/\.[^.]+$/, "");
      const caption = item.caption?.text?.trim() || cleanTitle;
      results.push({ url, caption });
      exclude.add(url);
    }
    return results;
  } catch (err) {
    console.error(`[blackboard] Wikipedia article media list failed for "${title}":`, err);
    return [];
  }
}

async function fetchTopicImages(topics: string[], limit = 5): Promise<{ url: string; caption: string }[]> {
  const results: { url: string; caption: string }[] = [];
  const seenUrls = new Set<string>();
  for (const topic of topics) {
    if (results.length >= limit) break;

    let hit = await fetchWikipediaSummary(topic);
    let resolvedTitle = hit?.caption ?? topic;
    if (!hit) {
      const alt = await resolveWikipediaTitle(topic);
      if (alt && alt.toLowerCase() !== topic.toLowerCase()) {
        hit = await fetchWikipediaSummary(alt);
        resolvedTitle = hit?.caption ?? alt;
      }
    }
    if (!hit) continue;

    if (!seenUrls.has(hit.url)) {
      seenUrls.add(hit.url);
      results.push(hit);
    }
    if (results.length >= limit) break;

    const more = await fetchArticleEmbeddedImages(resolvedTitle, limit - results.length, seenUrls);
    results.push(...more);
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

    // When real page content is available, it is the source of truth: the
    // model reads every selected page as one combined context (never page by
    // page) and determines the actual topic from that content, then applies
    // the teacher's instructions (if any) to shape the output. Without page
    // content (non-PDF/PPTX docs, or extraction failed client-side) we fall
    // back to treating the label the teacher typed/selected as the topic.
    const imageQueryInstruction = "imageQuery (the exact title of the real Wikipedia article about the single most central concept in the material — e.g. \"Chloroplast\", \"Water cycle\", \"Distributed file system\" — this will be used to directly look up that Wikipedia article, so it MUST be a real, existing encyclopedia topic, not a made-up descriptive phrase like \"process of energy conversion in plants\"; ALWAYS spell out the full term instead of a short acronym/abbreviation, even if the material itself uses the abbreviation — e.g. \"Distributed file system\" not \"DFS\", since short acronyms are frequently ambiguous (\"DFS\" is far more commonly Depth-first search) and would look up the wrong article entirely; if genuinely nothing in the material corresponds to a real, well-known encyclopedia topic, use an empty string), imageCount (integer: if the teacher's instructions explicitly ask for a specific number of images, use that exact number; otherwise default to 5)";
    const groundingRule = "Base your answer primarily on the given material. You may draw on your own knowledge to add helpful context or clarify a concept the material only mentions briefly, but anything you add must stay consistent with the material and must never contradict it.";
    const notesField = data.mode === "notes"
      ? ", detailedNotes (a thorough, well-organized written explanation of the material in multiple short paragraphs — not just a rephrasing of the bullet points, this should read like real study notes a student could learn from, covering definitions, how things work, and why they matter)"
      : "";
    const systemPrompt = data.pageText
      ? `You are a knowledgeable teacher's assistant analyzing classroom material. You will be given the combined text of one or more selected pages/slides from a document — treat all of it as a single unified context, not as separate pages. Read and understand the material first, then identify its actual subject matter yourself; do not just repeat any page numbers or labels back as the topic. The teacher's instructions are REQUIRED reading, not optional flavor text — if given, they must visibly shape what you emphasize, how you format the output, or what you focus on (e.g. "focus on the diagrams" or "summarize for a 5th grader"); instructions guide the output, they are not the topic. ${groundingRule} Return a JSON object with: topic (the real subject you identified, short string), overview (1-2 sentence summary), keyPoints (array of 4-6 concise bullet strings grounded in the given content)${notesField}, ${imageQueryInstruction}. Return ONLY valid JSON, no markdown.`
      : `You are a knowledgeable teacher's assistant. You'll be given a topic/document label and, optionally, the teacher's instructions. The instructions are REQUIRED reading, not optional flavor text — if given, they must visibly shape what you emphasize or how you format the output. ${groundingRule} Return a JSON object with: topic (string), overview (1-2 sentence summary), keyPoints (array of 4-6 concise bullet strings)${notesField}, ${imageQueryInstruction}. Return ONLY valid JSON, no markdown.`;
    const userContent = data.pageText
      ? `Combined content from the selected page(s):\n${data.pageText}\n\nTeacher's instructions (optional): ${data.instructions || "None"}`
      : `Topic: ${data.topic}\n\nTeacher's instructions (optional): ${data.instructions || "None"}`;

    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      // Notes mode asks for a much longer detailedNotes field on top of the
      // usual fields, so it needs a bigger budget than a quick summary.
      max_tokens: data.mode === "notes" ? 1400 : 650,
    });

    await deductTokens(institutionId, completion.usage?.total_tokens ?? 0, teacherId);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(completion.choices[0].message.content ?? "{}");
    } catch {
      throw new BadRequestError("AI returned malformed JSON — please retry");
    }
    // Look up the actual Wikipedia article(s) for the concept the AI
    // identified — never the raw page-label/instructions string
    // (`data.topic` in the fallback path), which is meta-information
    // ("Pages 3, 4 — ...") and not a real encyclopedia topic. This replaces
    // full-text keyword search against Commons (which repeatedly surfaced
    // unrelated results matching only incidental words) with a precise,
    // curated per-article image — a query that doesn't resolve to a real
    // Wikipedia article returns no image rather than a wrong one.
    const derivedTopic = typeof parsed.topic === "string" && parsed.topic.trim() ? parsed.topic : undefined;
    const imageQuery = typeof parsed.imageQuery === "string" && parsed.imageQuery.trim() ? parsed.imageQuery : undefined;
    const candidateTopics = [...new Set([imageQuery, derivedTopic].filter((q): q is string => !!q))];
    // Default to 5 images; honor an explicit count from the teacher's
    // instructions if the AI picked one up, within a sane [1, 10] range so a
    // single request can't trigger an excessive number of Wikipedia calls.
    const requestedImageCount = typeof parsed.imageCount === "number" && Number.isFinite(parsed.imageCount)
      ? Math.min(Math.max(Math.round(parsed.imageCount), 1), 10)
      : 5;
    const images = await fetchTopicImages(candidateTopics, requestedImageCount);

    const { imageQuery: _omit, imageCount: _omitCount, ...result } = parsed;
    res.json({ success: true, data: { ...result, images } });
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

