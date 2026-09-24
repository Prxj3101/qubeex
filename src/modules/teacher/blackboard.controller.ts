import crypto from "crypto";
import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { uploadAttachmentToR2, scheduleR2FileDeletion, r2KeyFromUrl } from "../../services/storage.service";
import { normalizePdfIfNeeded } from "../../services/pdfNormalize.service";
import { BadRequestError, NotFoundError, TooManyRequestsError } from "../../utils/errors";
import { createFolderSchema, aiScanSchema, aiChatSchema, aiQuizSchema, aiMindmapSchema } from "./blackboard.schema";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");
import { redis, isRedisReady } from "../../utils/redis";
import { getCache, setCache } from "../../utils/cache";
import { getAiTokenLimit } from "../../services/billing.service";
import { recordAiUsage, type AiFeature, institutionUsageRedisKey, checkTeacherSoftLimit } from "../../services/ai-usage.service";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpenAIModule = (process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY) ? require("openai") : null;
const openai: import("openai").OpenAI | null = OpenAIModule
  ? new OpenAIModule.OpenAI(
      process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : { apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" }
    )
  : null;
// llama-3.3-70b-versatile was retired from Groq's catalog (returns 404
// model_not_found) — openai/gpt-oss-120b is the current equivalent-tier
// general-purpose model there.
const AI_MODEL = process.env.OPENAI_API_KEY ? "gpt-4.1-mini" : "openai/gpt-oss-120b";
const AI_PROVIDER: "openai" | "groq" = process.env.OPENAI_API_KEY ? "openai" : "groq";

async function checkTokenPool(institutionId: string, teacherId?: string): Promise<void> {
  if (!openai) return;
  if (!redis || !isRedisReady) {
    if (redis) console.warn("[blackboard] Redis configured but not ready — token pool check skipped");
    return;
  }
  const usageKey = institutionUsageRedisKey(institutionId);
  // A Redis hiccup must not fail the whole request. ioredis rejects commands
  // after `commandTimeout` (5s), and an uncaught rejection here propagates to
  // the central error handler and returns a 500 — turning a transient cache
  // blip into a broken feature. Treat an unreadable counter as "no usage
  // recorded" and let the request proceed; the deduct below still runs, so
  // usage keeps accruing once Redis recovers.
  const [used, limitN] = await Promise.all([
    redis.get(usageKey).catch((err) => {
      console.warn("[blackboard] Token-pool read failed, allowing request:", err?.message ?? err);
      return null;
    }),
    getAiTokenLimit(institutionId),
  ]);
  const usedN = Number(used ?? 0);
  if (limitN > 0 && usedN >= limitN) {
    // Must be an AppError subclass — a plain Error with a bolted-on
    // statusCode is invisible to the central error handler and previously
    // fell through to a generic 500 instead of a real 429.
    throw new TooManyRequestsError("Token limit reached");
  }
  // Per-teacher soft limit — checked after the institution hard stop so an
  // institution that's already fully out of tokens fails on the cheaper
  // check first. See checkTeacherSoftLimit for why this actually blocks
  // despite the "soft" name.
  if (teacherId) {
    await checkTeacherSoftLimit(institutionId, teacherId);
  }
}

export const upload = multer({
  storage: multer.memoryStorage(),
  // 150MB covers even large scanned textbooks; without this multer allows
  // any size, which is more upload risk than the Blackboard needs.
  limits: { files: 1, fileSize: 150 * 1024 * 1024 },
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
  const teacher = await academicDb().teacher.findFirst({ where: { userId, institutionId }, select: { id: true } });
  if (!teacher) throw new BadRequestError("Teacher profile not found");
  return teacher.id;
}

// ── Storage: Folders ──────────────────────────────────────────────────────────

export const listFolders = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);

    const [folders, files] = await Promise.all([
      academicDb().blackboardFolder.findMany({
        where: { teacherId, institutionId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, parentId: true, createdAt: true },
      }),
      academicDb().blackboardMaterial.findMany({
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
      const parent = await academicDb().blackboardFolder.findFirst({
        where: { id: data.parentId, teacherId, institutionId },
      });
      if (!parent) throw new NotFoundError("Parent folder not found");
    }

    const folder = await academicDb().blackboardFolder.create({
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

    const folder = await academicDb().blackboardFolder.findFirst({ where: { id: folderId, teacherId, institutionId } });
    if (!folder) throw new NotFoundError("Folder not found");

    // Collect all descendant folder IDs (BFS)
    const allFolderIds: string[] = [folderId];
    const queue = [folderId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = await academicDb().blackboardFolder.findMany({
        where: { parentId: current, teacherId, institutionId },
        select: { id: true },
      });
      for (const c of children) { allFolderIds.push(c.id); queue.push(c.id); }
    }

    // Collect all r2Keys for files in these folders
    const files = await academicDb().blackboardMaterial.findMany({
      where: { folderId: { in: allFolderIds }, institutionId },
      select: { r2Key: true },
    });

    // Delete folders (deepest first to avoid FK issues — children cascade deletes files)
    for (let i = allFolderIds.length - 1; i >= 0; i--) {
      await academicDb().blackboardFolder.delete({ where: { id: allFolderIds[i] } });
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

    const folder = await academicDb().blackboardFolder.findFirst({ where: { id: folderId, teacherId, institutionId } });
    if (!folder) throw new NotFoundError("Folder not found");

    const file = req.file;
    if (!file) throw new BadRequestError("No file provided");
    if (!ALLOWED_MIMETYPES.has(file.mimetype)) {
      throw new BadRequestError("File type not allowed. Accepted: PDF, PPT, PPTX, DOC, DOCX");
    }

    // Some scanned PDFs embed images pdf.js can't decode (see
    // pdfNormalize.service.ts) — re-encode those at upload time so the
    // Blackboard viewer never has to deal with them. No-op (returns the
    // same buffer untouched) for the vast majority of PDFs, and for every
    // non-PDF file type.
    const fileBuffer = file.mimetype === "application/pdf"
      ? (await normalizePdfIfNeeded(file.buffer)).buffer
      : file.buffer;

    const result = await uploadAttachmentToR2(fileBuffer, {
      originalName: file.originalname,
      contentType: file.mimetype,
      institutionId,
      area: "blackboard",
      skipSizeLimit: true,
    });

    const r2Key = r2KeyFromUrl(result.publicUrl);
    if (!r2Key) throw new BadRequestError("R2 key extraction failed — check R2_PUBLIC_URL configuration");

    const material = await academicDb().blackboardMaterial.create({
      data: {
        institutionId,
        teacherId,
        folderId,
        name: file.originalname,
        fileUrl: result.publicUrl,
        r2Key,
        mimeType: file.mimetype,
        size: fileBuffer.length,
      },
      select: { id: true, name: true, fileUrl: true, mimeType: true, size: true, folderId: true, createdAt: true },
    });

    res.status(201).json({ success: true, data: material });
  } catch (err) { next(err); }
};

// Stateless pass-through for the "From Computer" flow, which loads a file
// client-side (blob: URL, never touches the server) and so never gets the
// benefit of normalizePdfIfNeeded the way a Storage upload does. The
// frontend only calls this when its own quick client-side byte-scan finds
// the problematic /JPXDecode marker, so most PDFs never hit this endpoint
// at all. Nothing here is persisted — no DB row, no R2 upload — it just
// takes bytes in and returns (possibly) cleaned-up bytes out.
export const normalizePdfUpload = async (
  req: AuthRequest & { file?: Express.Multer.File },
  res: Response,
  next: NextFunction
) => {
  try {
    requireTeacher(req);
    const file = req.file;
    if (!file) throw new BadRequestError("No file provided");
    if (file.mimetype !== "application/pdf") {
      throw new BadRequestError("Only PDF files are supported here");
    }

    const { buffer: normalized, status } = await normalizePdfIfNeeded(file.buffer);

    res.setHeader("Content-Type", "application/pdf");
    // Lets the "From Computer" frontend flow tell the difference between
    // "this PDF didn't need cleanup" and "we tried and it failed" — the
    // latter is worth a heads-up toast instead of silently serving the
    // untouched (still-broken) original.
    res.setHeader("X-Pdf-Normalize-Status", status);
    res.status(200).send(normalized);
  } catch (err) { next(err); }
};

export const deleteFile = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const fileId = req.params.id as string;

    const file = await academicDb().blackboardMaterial.findFirst({ where: { id: fileId, teacherId, institutionId } });
    if (!file) throw new NotFoundError("File not found");

    await academicDb().blackboardMaterial.delete({ where: { id: fileId } });
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

// ── School subject taxonomy ───────────────────────────────────────────────────
//
// Shared by two consumers. The mindmap renderer picks its paper, palette and
// handwriting from it (a biology map looks botanical, a history map looks like
// parchment), and image retrieval picks its search strategy from it. Same
// trick in both cases: the model chooses a name from a fixed list and we do
// the rest, so a bad value can only ever fall back to "general".
//
// Declared here rather than beside the mindmap code because CONTEXT_SYSTEM_PROMPT
// interpolates the list at module-evaluation time — defined later it would be
// in the temporal dead zone and throw on import.
const MINDMAP_SUBJECTS = [
  "biology", "chemistry", "physics", "maths", "history",
  "geography", "language", "computer", "general",
] as const;
type MindmapSubject = (typeof MINDMAP_SUBJECTS)[number];

function normalizeSubject(raw: unknown): MindmapSubject {
  if (typeof raw !== "string") return "general";
  const v = raw.trim().toLowerCase();
  return (MINDMAP_SUBJECTS as readonly string[]).includes(v) ? (v as MindmapSubject) : "general";
}

// What a good classroom visual actually IS depends entirely on the subject,
// and the previous one-size-fits-all "<topic> labelled diagram" was actively
// wrong for half of them: a History chapter searched that way returns generic
// timeline schematics instead of the painting, portrait or period photograph
// the lesson needs, and a Maths chapter returns anything but the graph.
//
//   commonsQualifiers — appended to each concept when searching Commons, tried
//                       in order until enough images are found.
//   webQualifier      — used for the (paid) web top-up query.
//   photosAreTheGoal  — true for subjects where the real thing teaches better
//                       than a drawing; flips diagram-first ranking off.
//   wantsAnimation    — true for subjects built on change over time, where an
//                       animated GIF is the single best classroom asset.
interface SubjectVisualProfile {
  commonsQualifiers: string[];
  webQualifier: string;
  photosAreTheGoal: boolean;
  wantsAnimation: boolean;
}

const SUBJECT_VISUAL_PROFILE: Record<MindmapSubject, SubjectVisualProfile> = {
  biology: {
    commonsQualifiers: ["labelled diagram", "diagram", "anatomy"],
    webQualifier: "labelled diagram",
    photosAreTheGoal: false,
    wantsAnimation: true,
  },
  chemistry: {
    commonsQualifiers: ["structure diagram", "reaction diagram", "apparatus"],
    webQualifier: "labelled diagram",
    photosAreTheGoal: false,
    wantsAnimation: true,
  },
  physics: {
    commonsQualifiers: ["diagram", "schematic", "apparatus"],
    webQualifier: "labelled diagram",
    photosAreTheGoal: false,
    wantsAnimation: true,
  },
  maths: {
    // "diagram" is close to meaningless in maths; the useful assets are plots,
    // geometric constructions and worked figures.
    commonsQualifiers: ["graph", "geometric figure", "plot"],
    webQualifier: "graph diagram",
    photosAreTheGoal: false,
    wantsAnimation: true,
  },
  history: {
    // The single biggest source of "irrelevant diagram" complaints. History is
    // taught from primary visual sources — paintings, portraits, photographs,
    // period maps — not from schematics.
    commonsQualifiers: ["painting", "portrait", "photograph", "historical map"],
    webQualifier: "historical photograph painting",
    photosAreTheGoal: true,
    wantsAnimation: false,
  },
  geography: {
    commonsQualifiers: ["map", "diagram", "satellite image"],
    webQualifier: "map diagram",
    photosAreTheGoal: true,
    wantsAnimation: true,
  },
  language: {
    commonsQualifiers: ["illustration", "portrait", "manuscript"],
    webQualifier: "illustration",
    photosAreTheGoal: true,
    wantsAnimation: false,
  },
  computer: {
    commonsQualifiers: ["diagram", "flowchart", "architecture diagram"],
    webQualifier: "architecture diagram",
    photosAreTheGoal: false,
    wantsAnimation: true,
  },
  general: {
    commonsQualifiers: ["diagram", "illustration"],
    webQualifier: "labelled diagram",
    photosAreTheGoal: false,
    wantsAnimation: true,
  },
};

// Below this, a raster image is an icon or a thumbnail rather than teaching
// material — it will be blurry the moment it is projected.
const MIN_IMAGE_WIDTH = 250;
// Web results get a much higher floor than Commons. Commons hosts vector SVGs
// whose nominal size means nothing, whereas a raster pulled off the open web at
// 300px is simply a thumbnail. Safe to set this high because the search itself
// now asks Google for large images only (see SERPAPI_TBS_FILTERS): measured on
// a live query, 99 of 100 results come back at 800px or more, so raising the
// floor costs essentially no candidates.
const MIN_WEB_IMAGE_WIDTH = 500;

async function fetchWikimediaImages(
  query: string,
  limit = 4,
  relevanceKeywords?: string[],
  illustrationsOnly = false,
  exclude?: Set<string>
): Promise<{ url: string; caption: string }[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: query,
    // Categories ride along in the same request — they're the reliable
    // safety signal (see isClassroomSafe), and asking for them here costs
    // no extra round trip.
    prop: "imageinfo|categories",
    iiprop: "url|extmetadata|size",
    cllimit: "max",
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
        imageinfo?: Array<{
          url: string;
          width?: number;
          height?: number;
          extmetadata?: { ImageDescription?: { value: string } };
        }>;
        categories?: Array<{ title: string }>;
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
    // Commons is full of small raster assets — flag icons, thumbnails, badges —
    // that match a topic query perfectly well and then look like mush on a
    // classroom projector. SVGs are exempt: a vector's nominal size says
    // nothing about how sharply it renders.
    if (!/\.svg/i.test(info.url) && info.width && info.width < MIN_IMAGE_WIDTH) continue;
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
    // Same gates every other source passes through — this function is now on
    // the main scan path, not just the standalone search endpoint.
    if (WIKI_CHROME_FILENAME_PATTERN.test(page.title)) continue;
    if (illustrationsOnly && !isIllustration(page.title, info.url)) continue;
    const categories = (page.categories ?? []).map((c) => c.title);
    if (!isClassroomSafe(page.title, info.url, categories, caption)) continue;
    if (exclude?.has(info.url)) continue;
    exclude?.add(info.url);
    results.push({ url: info.url, caption });
  }

  return results;
}

const WIKI_USER_AGENT = "QubeEx-Blackboard/1.0 (https://qubeex.app; contact@qubeex.app) node-fetch";

// ── Classroom-appropriate imagery ─────────────────────────────────────────────
//
// Some legitimate curriculum topics — human reproduction, anatomy — have
// encyclopedia articles that mix teaching diagrams with clinical photographs
// of real bodies. Those photographs are medically legitimate and pass ordinary
// SafeSearch (they aren't "explicit" in the sense filters look for), but they
// are not what a teacher should get when projecting onto a classroom board.
//
// For these subjects we restrict results to diagrams/illustrations only. The
// filter is deliberately strict: it will sometimes drop a legitimate diagram,
// which is the right trade in a product used with children — showing nothing
// is recoverable, showing a photograph of genitalia to a classroom is not.
// Deliberately broad. A false positive costs almost nothing — "diagrams only"
// is good pedagogy for any biology topic anyway — while a false negative puts
// a clinical photograph on a classroom projector. Note `reproduc\w*` not
// `reproduct\w*`: the earlier form missed "Reproduce", and "How do Organisms
// Reproduce?" is the standard chapter title for precisely this material.
// The second line is a widening for a product used with small children:
// human-body chapters that never mention reproduction still pull clinical
// photography out of open-web image search — "Life Processes" (excretion),
// "Control and Coordination" (hormones, puberty), and anything touching
// disease, surgery or dissection. A false positive here only means the class
// gets a labelled diagram instead of a photograph, which is the better
// classroom asset regardless.
// Split into two tiers after a real false positive: a Class-4 history chapter
// on Shivaji Maharaj's early life was flagged sensitive, which forced
// diagrams-only, rejected every painting and portrait of him, disabled web
// search and returned ZERO images for the lesson. The cause was the clinical
// widening below being matched against the entire raw chapter text, where
// ordinary historical prose ("wounded in battle", "adolescence", "pregnant")
// trips it.
//
// CORE — body/reproductive vocabulary that implies human-body imagery no
// matter what subject it appears in. Checked everywhere, including raw text.
// Unchanged in strength: this is what actually protects the classroom.
// UNCONDITIONAL — vocabulary that only ever describes human sexual anatomy or
// explicit material. Sensitive wherever it appears, in any subject.
const SENSITIVE_EXPLICIT_PATTERN =
  /\b(genital\w*|penis|penile|vulva|vagin\w*|testis|testes|testicl\w*|scrotum|uterus|uterine|cervix|cervical|clitoris|labia|nipple\w*|areola|breast\w*|mammary|prostate|urethra\w*|menstrua\w*|menopause|puberty|pubert\w*|intercourse|coitus|copulat\w*|masturbat\w*|ejaculat\w*|semen|seminal|condom|contracept\w*|abortion|nude|naked|erotic|dissect\w*|cadaver|autops\w*)\b/i;

// CONDITIONAL — general BIOLOGY vocabulary. "Ovary", "gamete", "embryo",
// "sexual reproduction" and "anatomy" describe sponges, jellyfish and flowers
// just as much as people, so on their own they say nothing about whether human
// imagery is at risk.
//
// Written after a Class-9 zoology scan on sponges and cnidarians was flagged
// sensitive on the single word "Ovary". That disabled web search, restricted
// results to Wikimedia diagrams, and — with Commons unreachable — returned
// ZERO images for the lesson. The same false positive hits every flowering-
// plant chapter, since plants have ovaries too.
const SENSITIVE_BIOLOGICAL_PATTERN =
  /\b(reproduc\w*|sexual\w*|ovar(?:y|ies|ian)|ovum|ova|oocyte\w*|sperm\w*|gamete\w*|zygote|embryo\w*|fetus|foetus|fetal|foetal|fertilis\w*|fertiliz\w*|gestation|placenta\w*|umbilical|lactation|insemination|surrogac\w*|anatomy|anatomical)\b/i;

// What turns the conditional tier on: an indication the material is about
// PEOPLE. Deliberately excludes "man"/"men"/"male"/"female" — "male and female
// gametes" is ordinary botany, and "Portuguese man o' war" is a jellyfish.
const HUMAN_CONTEXT_PATTERN =
  /\b(human|humans|humanity|woman|women|boy|boys|girl|girls|child|children|infant|baby|babies|adolescen\w*|puberty|pubert\w*|menstrua\w*|homo sapiens|mother|father|pregnan\w*|patient)\b/i;

// CLINICAL — medical/physiological vocabulary that only implies clinical
// photography when the lesson is actually about the human body. In a history,
// geography, maths or literature chapter these words are just prose, and
// treating them as sensitive silently empties the image panel.
const SENSITIVE_CLINICAL_PATTERN =
  /\b(pregnan\w*|excret\w*|urinar\w*|bladder|kidney\w*|endocrine|hormon\w*|adolescen\w*|surger\w*|surgical|wound\w*|lesion\w*|ulcer\w*|tumou?r\w*|cancer\w*|deformit\w*|amputat\w*|physiolog\w*)\b/i;

// Subjects whose image space actually contains human bodies. For the others,
// the clinical tier is skipped — a battle described as "wounding" a general
// carries no risk of a clinical photograph reaching the board.
const BODY_ADJACENT_SUBJECTS = new Set<MindmapSubject>(["biology", "chemistry", "general"]);

// SVG is a vector format — a photograph cannot be one — so it's a reliable
// "this is a drawn diagram" signal. Beyond that, recognise well-established
// illustration markers: scheme/diagram naming, the Blausen medical
// illustration library, and Gray's/Sobotta anatomy plates (19th-c. engravings).
// Broadened after finding real schematics being misread as photos — the USGS
// water-cycle poster and "HydrologicalCycle1.png" are both diagrams whose
// names carry none of the obvious keywords. Cycle/structure/anatomy naming and
// the "-en"/"-de" language suffix (which only labelled diagrams carry, since
// only they contain translatable text) are strong additional signals.
// Word-bounded on the risky terms: an unbounded "graph" matched "Graphite",
// promoting a photograph of a reactor core to the top of the diagram list.
const ILLUSTRATION_HINT =
  /(diagram|illustration|schematic|scheme\b|illu[_ ]|blausen|gray\d{3,4}|sobo[_ ]|labell?ed|cross[_ -]?section|drawing|sketch|\bchart\b|\bgraph\b|\bcycle\b|pathway|\bstructure\b|map-|-en\.(svg|png)|_en\.(svg|png)|infographic|flowchart|\bschema\b)/i;

// Names that mark an animated GIF as a teaching animation of a process rather
// than incidental footage. Used only to admit GIFs on sensitive topics.
const PROCESS_ANIMATION_HINT =
  /(anim|cycle|process|mitosis|meiosis|division|stages?|phases?|sequence|motion|flow|rotat|orbit|pump|wave|reaction|formation|development|growth|how[_ ]it[_ ]works)/i;

// Applied to EVERY image, regardless of whether the topic was flagged
// sensitive. Topic detection gates on the AI's word choices, so a single
// unanticipated phrasing would let a photograph through — this is the
// backstop that doesn't depend on that inference being right. A file named
// for explicit anatomy is only ever allowed through if it is also clearly a
// drawn diagram (e.g. "Vaginal_opening_description-en.svg", a labelled
// biology illustration, passes; "Front_and_back_womans_genitalia.jpg" does not).
const EXPLICIT_ANATOMY_FILENAME_PATTERN =
  /(genital\w*|penis|penile|vulva|vagina|scrotum|testicle\w*|breast\w*|nipple\w*|nude|naked|erect\w*|flaccid|labia|clitoris|anus|anal|buttock\w*|pubic|topless|semen|ejaculat\w*|masturbat\w*|coitus|copulat\w*)/i;

// Filenames on Commons are user-supplied and frequently say nothing about the
// content ("IMG_2531.jpg", or a name in another language), so a filename-only
// gate lets an explicit photograph through whenever it happens to be named
// innocuously. Categories are curated by Commons editors and are the reliable
// signal: explicit media is systematically filed under these regardless of
// what the uploader called the file.
const EXPLICIT_CATEGORY_PATTERN =
  /(nudity|nude|naked|topless|genital|penis|penile|vulva|vagina|scrotum|testicl|nipple|erotic|pornograph|sexual intercourse|sexual activity|coitus|copulat|masturbat|ejaculat|semen|pubic|clitoris|labia|buttock|anus|human anus|fetish|bdsm|prostitut|erection|breastfeed|lactating)/i;

// Real human anatomy must never reach a classroom board as a PHOTOGRAPH.
// The explicit-filename and category patterns above only catch sexual/nude
// content; they say nothing about a photograph of a dissected human heart, a
// cadaver, a surgical field, a skin lesion or a preserved specimen — all of
// which are legitimate encyclopedia images and all of which are wrong in front
// of small children. Matching here forces the image to be a drawn diagram,
// which is the better teaching asset anyway.
//
// Unambiguous anatomical vocabulary: these words are essentially only used
// about bodies, so matching them outright is safe.
const HUMAN_ANATOMY_PATTERN =
  /\b(human anatomy|human body|anatomical|cadaver\w*|autops\w*|post[- ]?mortem|dissect\w*|viscera\w*|thorax|thoracic|abdomen|abdominal|larynx|pharynx|o?esophagus|trachea|bronch\w*|intestin\w*|duodenum|rectum|anus|urethra\w*|bladder|kidney\w*|hepatic|spleen|pancrea\w*|uterus|uterine|ovar(?:y|ies|ian)|testis|testes|testicl\w*|penis|penile|vulva|vagin\w*|scrotum|nipple\w*|areola|breast\w*|buttock\w*|groin|pubic|navel|umbilic\w*|axilla\w*|sternum|clavicle|femur|tibia|fibula|humerus|vertebra\w*|pelvis|pelvic|cranium|mandible|scapula|cerebrum|cerebell\w*|brainstem|spinal cord|meninges|aorta|aortic|myocardi\w*|retina\w*|cornea\w*|sclera|cochlea\w*|eardrum|tympanic|epidermis|dermis|mucosa|placenta\w*|embryo\w*|fetus|foetus|fetal|foetal|sperm\w*|ovum|zygote|nephron|alveol\w*|lesion\w*|surgical|surgery|amputat\w*|prosthe\w*|pubert\w*|menstrua\w*|menopaus\w*|lactat\w*|breastfeed\w*|circumcis\w*|topless|undress\w*)\b/i;

// Generic body words ("heart", "skull", "skin") are far too common to block on
// their own — "heart of the city", "Skull Rock", a dinosaur skeleton. They only
// indicate human anatomy when a human subject is named alongside them.
const GENERIC_BODY_PART_PATTERN =
  /\b(skeleton|skull|torso|muscle\w*|organs?|bones?|skin|blood|brain|heart|lungs?|liver|stomach|eyeball|intestine|throat|thigh|limbs?|nerve\w*|artery|arteries|tissue)\b/i;
const HUMAN_SUBJECT_PATTERN =
  /\b(human|humans|man|men|woman|women|male|female|child|children|infant|baby|patient|corpse|body|person|adult|boy|girl)\b/i;

// Deliberately narrower than ILLUSTRATION_HINT. Only signals that a real
// photograph cannot plausibly carry: a vector format, an explicit "diagram"/
// "illustration" naming, or one of the known medical-illustration libraries.
// Weak hints ("cross-section", "structure", "cycle", "chart") are excluded —
// a photograph of a sectioned cadaver is literally a cross-section.
const ANATOMY_ILLUSTRATION_HINT =
  /(diagram|illustration|schematic|labell?ed|blausen|gray\d{3,4}|sobo[_ ]|drawing|sketch|infographic|flowchart|\bscheme\b|\bschema\b|-en\.(svg|png)|_en\.(svg|png))/i;

function isAnatomyIllustration(title: string, url: string): boolean {
  const haystack = `${title} ${url}`;
  if (/\.svg/i.test(haystack)) return true;
  return ANATOMY_ILLUSTRATION_HINT.test(haystack);
}

function isHumanAnatomy(haystack: string): boolean {
  if (HUMAN_ANATOMY_PATTERN.test(haystack)) return true;
  return GENERIC_BODY_PART_PATTERN.test(haystack) && HUMAN_SUBJECT_PATTERN.test(haystack);
}

/**
 * Final gate every image passes through before it can be returned to a
 * classroom. Anything flagged by filename, description or Commons category is
 * not hard-blocked but demoted to "diagram only" — a labelled illustration of
 * human anatomy is exactly what a biology lesson needs; a clinical photograph
 * of the same subject is not.
 */
function isClassroomSafe(
  title: string,
  url: string,
  categories?: string[],
  caption?: string,
): boolean {
  const haystack = `${title} ${url} ${caption ?? ""}`;
  const flagged =
    EXPLICIT_ANATOMY_FILENAME_PATTERN.test(haystack) ||
    isHumanAnatomy(haystack) ||
    (categories?.some((c) => EXPLICIT_CATEGORY_PATTERN.test(c)) ?? false) ||
    (categories?.some((c) => isHumanAnatomy(c)) ?? false);
  if (!flagged) return true;
  // Diagrams and labelled illustrations still pass — that is precisely what a
  // biology lesson needs. Only the photograph is refused. Note the STRICTER
  // test: the general isIllustration heuristic accepts weak hints like
  // "cross-section" or "structure" that a photograph of a real dissected organ
  // satisfies just as well as a drawing does.
  return isAnatomyIllustration(title, url);
}

/**
 * `rawText` matters as much as the context here: sensitivity is decided from
 * what the document actually says, not only from how the model chose to
 * summarise it. A chapter can be titled "Life Processes" or "Chapter 8" and
 * still be entirely about reproduction — the page text gives that away even
 * when the derived topic doesn't.
 */
function isSensitiveSubject(context: DocumentContext, rawText?: string): string | null {
  const haystack = [
    context.topic,
    context.conceptType,
    ...context.subtopics,
    ...context.keywords,
    ...context.suggestedVisuals,
    rawText ?? "",
  ].join(" ");

  // Returns the matching term rather than a boolean: when this fires it
  // empties the image panel, and without knowing WHICH word tripped it a
  // false positive is undiagnosable from the logs.
  const explicit = haystack.match(SENSITIVE_EXPLICIT_PATTERN);
  if (explicit) return explicit[0];

  // General biology vocabulary only counts when the material is about people.
  // A human-reproduction chapter names humans constantly (and trips the
  // explicit tier anyway); a sponge or a flower chapter does not.
  const humanContext = HUMAN_CONTEXT_PATTERN.test(haystack);
  if (humanContext) {
    const biological = haystack.match(SENSITIVE_BIOLOGICAL_PATTERN);
    if (biological) return `${biological[0]} (human context)`;
  }

  if (BODY_ADJACENT_SUBJECTS.has(context.subject ?? "general")) {
    const clinical = haystack.match(SENSITIVE_CLINICAL_PATTERN);
    if (clinical) return clinical[0];
  }
  return null;
}

/**
 * An animated GIF. Ranked as its own category rather than lumped in with
 * photos: for anything that changes over time — mitosis, an engine cycle,
 * wave motion, an orbit — an animation is the single best thing a teacher can
 * put on the board, and the old code buried them. `isIllustration` stays the
 * strict gate (a bare GIF still fails it), so sensitive-subject filtering is
 * unaffected by this; this function only influences ordering.
 */
function isAnimation(title: string, url: string): boolean {
  return /\.gif/i.test(`${title} ${url}`);
}

/**
 * True when an image looks like a drawn diagram rather than a photograph.
 * Checks the original filename (via title or URL) rather than the delivered
 * URL's extension — Wikimedia serves PNG-rendered thumbnails of SVG sources,
 * so the delivered file is often .png even when the original is a vector.
 */
function isIllustration(title: string, url: string): boolean {
  const haystack = `${title} ${url}`;
  if (/\.svg/i.test(haystack)) return true;
  if (ILLUSTRATION_HINT.test(haystack)) return true;
  // Animated GIFs are among the best classroom assets for anything that
  // changes over time (mitosis, engine cycles, wave motion), and Wikipedia
  // serves them unthumbnailed so the animation survives. Allow them on
  // sensitive topics only when the name reads as a process/animation rather
  // than arbitrary footage — an animated diagram of cell division is exactly
  // what a biology teacher wants; an unlabelled clip is not.
  if (/\.gif/i.test(haystack) && PROCESS_ANIMATION_HINT.test(haystack)) return true;
  return false;
}

// Look up the actual Wikipedia article for a topic and return its curated
// lead image, instead of full-text searching Commons for files that merely
// mention matching words somewhere in their metadata. Wikipedia's REST
// summary endpoint resolves redirects/disambiguation automatically (so
// "DFS" → "Distributed file system" article works if that's the real title),
// and the lead image is manually chosen by editors to represent that exact
// article's subject — precise by construction, not by keyword filtering.
// Free, same WMF infrastructure, no API key.
async function fetchWikipediaSummary(
  title: string,
  illustrationsOnly = false
): Promise<{ url: string; caption: string } | null> {
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
    // An article's lead image is editor-chosen to represent the subject, which
    // for anatomy topics is frequently a clinical photograph.
    if (illustrationsOnly && !isIllustration(json.title ?? title, url)) return null;
    if (!isClassroomSafe(json.title ?? title, url)) return null;
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
// Models like to write concept names with typographic punctuation — U+2011
// non-breaking hyphens ("Five‑kingdom"), en dashes, curly quotes. Those never
// appear in Wikipedia titles and only hurt search, so flatten them first.
function normalizeSearchText(query: string): string {
  return query
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Words that head thousands of Wikipedia titles. Sharing one of these with a
// query proves nothing about relevance — "energy" is common to both
// "Hydroelectric power generation" and "Energy transformation", and letting it
// validate a match is what pulled generic physics diagrams into lessons about
// specific power stations.
const GENERIC_TITLE_WORDS = new Set([
  "energy", "power", "system", "systems", "process", "processes", "conversion",
  "transformation", "generation", "method", "methods", "type", "types", "kind",
  "structure", "function", "principle", "principles", "theory", "science",
  "study", "development", "production", "technology", "effect", "effects",
  "cycle", "model", "analysis", "application", "applications", "introduction",
  "overview", "general", "material", "materials", "natural", "human", "world",
  "life", "form", "forms", "unit", "units", "change", "changes", "source",
  "sources", "resource", "resources", "concept", "basic", "basics", "working",
]);

/** The terms that actually identify what a query is about. */
function distinctiveTerms(query: string): string[] {
  const words = keywordsOf(query);
  const specific = words.filter(w => !GENERIC_TITLE_WORDS.has(w));
  // A query made entirely of generic words ("Energy conversion") has nothing
  // distinctive to check, so fall back rather than reject everything.
  return specific.length > 0 ? specific : words;
}

/**
 * Whole-word matching is wrong here: Wikipedia titles inflect ("Hydroelectric"
 * -> "Hydroelectricity", "Photosynthesis" -> "Photosynthetic"), so a strict
 * boundary match discards the correct article. Compare stems instead — one
 * word being a prefix of the other, with a length floor so short fragments
 * can't match everything.
 */
const STEM_PREFIX_MIN = 6;

/** Length of the leading run two words have in common. */
function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function termMatchesTitle(term: string, title: string): boolean {
  const titleWords = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return titleWords.some(tw =>
    tw === term ||
    (tw.startsWith(term) && term.length >= 5) ||
    (term.startsWith(tw) && tw.length >= 5) ||
    // Inflections that diverge rather than extend — "photosynthesis" against
    // "photosynthetic", "electrical" against "electricity" — share a stem but
    // neither is a prefix of the other, so a startsWith test alone drops the
    // correct article.
    sharedPrefixLength(tw, term) >= STEM_PREFIX_MIN
  );
}

function titleMatchesQuery(title: string, query: string): boolean {
  const terms = distinctiveTerms(query);
  if (terms.length === 0) return true;
  return terms.some(t => termMatchesTitle(t, title));
}

// Wikipedia titles are subjects ("Nuclear power plant"), never descriptions
// ("Schematic diagram of a nuclear power plant showing reactor, turbine,
// generator and cooling system"). The model writes the latter however firmly
// it is told not to, and every one of them 404s — so strip the scaffolding
// before looking a query up. The ORIGINAL query is still what web search sees,
// since Google handles descriptive phrasing well.
const QUERY_SCAFFOLD_PREFIX =
  /^(?:a |an |the )?(?:labell?ed |simple |detailed |annotated |basic )*(?:schematic |cross[- ]?sectional? |line )?(?:comparison chart|flow ?chart|infographic|schematic|diagram|illustration|drawing|sketch|chart|graph|map|photograph|photo|image|picture|figure|layout)s?\s+(?:of|showing|for|depicting)\s+(?:the |a |an )?/i;

const QUERY_SCAFFOLD_SUFFIX =
  /\s+(?:schematic|diagram|illustration|drawing|sketch|chart|graph|layout|figure|infographic|flow ?chart|labell?ed)s?$/i;

// Everything after these reads as elaboration, not subject.
const QUERY_TAIL_CLAUSE =
  /\s+(?:showing|indicating|depicting|illustrating|including|containing|with|versus|vs\.?|and their|that |which |where |labell?ed with)\b.*$/i;

/**
 * The searchable subject inside a descriptive image query.
 *   "Nuclear power plant schematic diagram"                    -> "Nuclear power plant"
 *   "Diagram of the uranium-235 fission chain reaction with..." -> "uranium-235 fission chain reaction"
 *   "Map of India indicating ... of major nuclear power plants" -> "major nuclear power plants"
 */
function coreSubject(query: string): string {
  let text = normalizeSearchText(query);

  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(QUERY_SCAFFOLD_PREFIX, "").trim();
  }

  const withoutTail = text.replace(QUERY_TAIL_CLAUSE, "").trim();
  // A tail cut that leaves a single bare word ("India") has thrown away the
  // real subject, which in these phrasings sits after the LAST "of".
  if (withoutTail.split(/\s+/).length < 2) {
    const afterLastOf = text.split(/\s+of\s+/i).pop()?.trim() ?? "";
    text = afterLastOf.split(/\s+/).length >= 2 ? afterLastOf : (withoutTail || text);
  } else {
    text = withoutTail;
  }

  previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(QUERY_SCAFFOLD_SUFFIX, "").trim();
  }

  text = text.replace(/[,;:]+$/, "").trim();
  // Never return something too small to search with.
  return text.length >= 3 ? text : normalizeSearchText(query);
}

async function wikipediaOpenSearch(query: string): Promise<string | null> {
  const res = await fetch(
    `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&namespace=0&limit=1&search=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": WIKI_USER_AGENT }, signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) return null;
  const json = await res.json() as [string, string[], string[], string[]];
  return json[1]?.[0] ?? null;
}

async function wikipediaFullTextSearch(
  query: string
): Promise<{ title: string; snippet: string } | null> {
  const params = new URLSearchParams({
    action: "query", format: "json", list: "search",
    srnamespace: "0", srlimit: "1", srsearch: query,
  });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params.toString()}`, {
    headers: { "User-Agent": WIKI_USER_AGENT }, signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const json = await res.json() as {
    query?: { search?: Array<{ title: string; snippet?: string }> };
  };
  const hit = json.query?.search?.[0];
  if (!hit) return null;
  // The snippet is the reason the guard can accept a correctly-matched article
  // whose TITLE shares no word with the query — see resolveWikipediaTitle.
  return { title: hit.title, snippet: (hit.snippet ?? "").replace(/<[^>]*>/g, "") };
}

/**
 * Resolve a concept to a real Wikipedia article title.
 *
 * opensearch alone was the entire reason free images kept coming back empty:
 * it is a PREFIX search over titles, so it only ever matches when the query is
 * the literal beginning of an article name. The concepts a scan produces are
 * descriptive phrases — "Vertebrate classes", "Chordate body plan",
 * "Five kingdom classification" — none of which prefix any title. Measured
 * against live Wikipedia, opensearch resolved 0 of 6 real scan queries while
 * full-text search resolved 6 of 6, reaching 44 article images that were
 * previously unreachable. Every scan was therefore falling through to paid
 * web search for imagery Wikipedia had all along.
 *
 * Order matters: opensearch first because an exact title match is precise,
 * then full-text as the fallback for descriptive phrasing.
 */
async function resolveWikipediaTitle(query: string): Promise<string | null> {
  const normalized = coreSubject(query);
  try {
    const exact = await wikipediaOpenSearch(normalized);
    if (exact) return exact;

    const found = await wikipediaFullTextSearch(normalized);
    if (!found) return null;

    // Full-text search always returns its best guess, however weak. The guard
    // has to be specific in BOTH directions — an earlier "share any word"
    // version failed both ways on real queries:
    //
    //   "Conversion of potential energy to electrical energy"
    //        -> "Energy transformation"   ACCEPTED on the word "energy" alone
    //   "Energy conversion in a hydroelectric plant"
    //        -> "Hydroelectricity"        REJECTED, because \bhydroelectric\b
    //                                     does not match inside "Hydroelectricity"
    //
    // which is exactly the reported symptom: a lesson on hydroelectric power
    // showing generic "energy conversion" diagrams. So: match on DISTINCTIVE
    // terms only, and match them by stem rather than whole word.
    // Match against title AND snippet. Wikipedia titles species by COMMON name
    // while a scan queries by scientific name, so a title-only check rejected
    // correct articles outright: "Euplectella glass sponge" resolves to
    // "Venus' flower basket" and "Physalia physalis" to "Portuguese man o' war",
    // neither sharing a word with the query — yet both snippets name the
    // species explicitly. That rejection is why a sponges-and-cnidarians scan
    // came back with nothing.
    if (!titleMatchesQuery(`${found.title} ${found.snippet}`, normalized)) {
      console.log(`[blackboard] Full-text match "${found.title}" rejected as unrelated to "${normalized}"`);
      return null;
    }
    return found.title;
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
const WIKI_CHROME_FILENAME_PATTERN = /(protection-shackle|padlock|edit-icon|question_book|commons-logo|wiktionary-logo|wikiquote-logo|wikisource-logo|wikinews-logo|wikispecies-logo|wikiversity-logo|wikivoyage-logo|wikidata-logo|ambox|disambig_gray|red_pog|ooui_|openclipart|gnome-mime|nuvola|crystal_clear|_icon\.svg|speakerlink|loudspeaker|increase2?\.svg|decrease2?\.svg)/i;

async function fetchArticleEmbeddedImages(
  title: string,
  limit: number,
  exclude: Set<string>,
  illustrationsOnly = false
): Promise<{ url: string; caption: string }[]> {
  if (limit <= 0) return [];
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/media-list/${encodeURIComponent(title)}`, {
      headers: { "User-Agent": WIKI_USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
    // Logged rather than silently swallowed: a 404 here means the title was
    // never a real article, and the silence made "no free images" look like a
    // network problem when it was a title-resolution problem.
    if (!res.ok) {
      console.log(`[blackboard] No Wikipedia article media for "${title}" (HTTP ${res.status})`);
      return [];
    }

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
      // Match on item.title (the original filename) — srcset serves PNG
      // renderings of SVG sources, so the delivered URL alone would misjudge
      // vector diagrams as raster photos.
      if (illustrationsOnly && !isIllustration(item.title, url)) continue;
      if (!isClassroomSafe(item.title, url)) continue;
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

// How many concepts are worth resolving to a Wikipedia article per scan.
// The scan asks the model for 3-6 imageQueries; beyond that we are into
// backup subtopics whose articles add latency without adding relevance.
const MAX_TOPICS_PER_LOOKUP = 8;
// Floor on what each concept may contribute, so a concept late in the list
// still gets a fair shot even when the limit divides small.
const MIN_IMAGES_PER_TOPIC = 2;

async function fetchTopicImages(
  topics: string[],
  limit = 5,
  seenUrls: Set<string> = new Set(),
  illustrationsOnly = false
): Promise<{ url: string; caption: string }[]> {
  const wanted = topics.slice(0, MAX_TOPICS_PER_LOOKUP);
  if (wanted.length === 0) return [];

  // Per-concept quota, not a shared pool. Previously this loop ran
  // first-come-take-all against a single `limit`: a well-illustrated first
  // article (20+ embedded images) consumed the entire budget and the loop
  // broke before concepts 2..6 were searched at all — so the visuals the AI
  // scan actually chose never appeared. Quota + round-robin means every
  // concept the scan named is represented, in the scan's own priority order.
  const perTopic = Math.max(MIN_IMAGES_PER_TOPIC, Math.ceil(limit / wanted.length));

  const buckets: { url: string; caption: string }[][] = [];
  for (const topic of wanted) {
    const bucket: { url: string; caption: string }[] = [];

    // Resolve the article even when its lead image is rejected by the
    // illustration filter — the article body often still holds usable
    // diagrams, which is exactly the case for anatomy topics.
    let hit = await fetchWikipediaSummary(topic, illustrationsOnly);
    let resolvedTitle: string | null = hit?.caption ?? null;
    if (!hit) {
      const alt = await resolveWikipediaTitle(topic);
      if (alt) {
        hit = await fetchWikipediaSummary(alt, illustrationsOnly);
        resolvedTitle = hit?.caption ?? alt;
      }
    }
    // Only ever ask for media by a title that actually resolved. Previously
    // this fell back to the raw query, so a descriptive phrase went straight to
    // the media-list endpoint and 404'd — which is what filled the log with
    // "No Wikipedia article media for 'Nuclear power plant schematic diagram'".
    if (!resolvedTitle) {
      buckets.push([]);
      continue;
    }

    if (hit && !seenUrls.has(hit.url)) {
      seenUrls.add(hit.url);
      bucket.push(hit);
    }
    if (bucket.length < perTopic) {
      bucket.push(...await fetchArticleEmbeddedImages(
        resolvedTitle,
        perTopic - bucket.length,
        seenUrls,
        illustrationsOnly
      ));
    }
    buckets.push(bucket);
  }

  // Round-robin: one image from each concept, then a second from each, and so
  // on. The teacher sees coverage of everything the scan identified before
  // they see a third picture of the first concept.
  const results: { url: string; caption: string }[] = [];
  const depth = Math.max(0, ...buckets.map(b => b.length));
  for (let i = 0; i < depth && results.length < limit; i++) {
    for (const bucket of buckets) {
      if (results.length >= limit) break;
      if (i < bucket.length) results.push(bucket[i]);
    }
  }
  return results;
}

// ── Serper (optional, paid) ───────────────────────────────────────────────────
//
// Wikipedia is precise but has real coverage gaps: well-documented topics
// ("Chloroplast") have plenty of curated diagrams, while niche technical ones
// ("Distributed file system") have none. Serper reaches the wider educational
// web to fill those gaps, at a lower per-query price than Google CSE.
//
//   SERPER_API_KEY = key from serper.dev (2,500 free queries to start)
//
// Licensing note: unlike Google CSE, Serper exposes no usage-rights filter and
// returns no license field. Rather than a hard licence gate (which no source
// can satisfy for many technical subjects — CS diagrams essentially do not
// exist under open licences), this uses an educational-use posture:
//
//   1. Hard-block source categories that are never usable in a classroom —
//      watermarked stock, pinboards, AI-generated art, video thumbnails.
//   2. Prefer known educational publishers, but don't require them, so
//      subjects like computer science still return results.
//
// PREFERRED_IMAGE_DOMAINS is therefore a ranking signal, not a gate. Note the
// tiering: the first group is openly licensed (CC or public domain) and safe
// to reuse outright; the rest are reputable but copyrighted, included under
// the educational-use posture above.
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const PREFERRED_IMAGE_DOMAINS = [
  // — Openly licensed (CC / public domain) —
  "wikipedia.org", "wikimedia.org", "wikibooks.org", "wikiversity.org",
  "openstax.org", "libretexts.org", "ck12.org", "siyavula.com",
  "nih.gov", "nasa.gov", "noaa.gov", "usgs.gov", "cdc.gov", "ed.gov", "nist.gov",
  // — Reputable reference & school publishers (copyrighted) —
  "britannica.com", "nationalgeographic.org", "khanacademy.org",
  "ncert.nic.in", "nios.ac.in", "byjus.com", "vedantu.com", "toppr.com",
  "biologydictionary.net", "sciencefacts.net", "physicsclassroom.com",
  "energyeducation.ca",
  // — Technical / CS teaching sources (copyrighted) —
  "geeksforgeeks.org", "tutorialspoint.com", "javatpoint.com", "programiz.com",
  "baeldung.com", "opengenus.org", "scaler.com", "interviewbit.com",
  "digitalocean.com", "techtarget.com", "kubernetes.io", "redhat.com",
  "ibm.com", "microsoft.com", "oracle.com", "cloudflare.com",
  // — Academic —
  "researchgate.net", "sciencedirect.com", "springer.com", "arxiv.org",
  "ieee.org", "acm.org", "nature.com",
];

// Never usable in a classroom, whatever the subject: watermarked commercial
// stock, pinboards/social re-hosts with no provenance, AI-generated art (which
// invents plausible-looking but wrong diagrams), and video thumbnails.
const BLOCKED_IMAGE_DOMAINS = [
  "shutterstock.com", "gettyimages.com", "istockphoto.com", "alamy.com",
  "dreamstime.com", "depositphotos.com", "123rf.com", "vectorstock.com",
  "freepik.com", "stock.adobe.com", "canstockphoto.com",
  "pinterest.com", "pinimg.com", "facebook.com", "fbcdn.net", "fbsbx.com", "instagram.com",
  "twitter.com", "x.com", "twimg.com", "tiktok.com", "licdn.com", "redd.it",
  "ytimg.com", "youtube.com", "vimeocdn.com",
  "easy-peasy.ai", "midjourney.com", "openai.com", "leonardo.ai", "civitai.com",
  // Found in live SerpAPI results for a nuclear-power query and previously
  // unblocked. AI-generated diagrams are the worst possible classroom asset:
  // they look authoritative and are confidently wrong.
  "craiyon.com", "stablediffusionweb.com", "lexica.art", "nightcafe.studio",
  "deepai.org", "artbreeder.com", "playground.com", "openart.ai",
  // Stock marketplaces that slipped past the existing list.
  "vecteezy.com", "vectorstock.com", "shutterstock.net", "storyblocks.com",
  "pngtree.com", "cleanpng.com", "kisspng.com", "seekpng.com", "pngwing.com",
];

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Host must equal a listed domain or be a subdomain of it — never a mere substring. */
function hostMatches(host: string, domains: string[]): boolean {
  return domains.some(d => host === d || host.endsWith(`.${d}`));
}

function isBlockedImageSource(rawUrl: string): boolean {
  const host = hostOf(rawUrl);
  if (!host) return true; // unparseable — reject
  return hostMatches(host, BLOCKED_IMAGE_DOMAINS);
}

/** Ranking signal: known-good educational publisher, or any academic institution. */
function isPreferredImageSource(rawUrl: string): boolean {
  const host = hostOf(rawUrl);
  if (!host) return false;
  // Universities worldwide publish course diagrams: .edu, plus academic
  // second-level domains like ac.uk / ac.in / edu.au.
  if (/\.edu$/.test(host) || /\.(ac|edu)\.[a-z]{2}$/.test(host)) return true;
  return hostMatches(host, PREFERRED_IMAGE_DOMAINS);
}

// Web search providers return the IMAGE url, not a page url — so requiring a
// file extension there only discards images served from CDNs that don't use
// one. Measured against a live SerpAPI response for "Nuclear power plant
// schematic diagram", the extension test dropped 10 of 100 results, and four
// of those were exactly the material a teacher wants: a HowStuffWorks cutaway,
// a ResearchGate figure, a RevisionDojo revision diagram and a Cloudinary-hosted
// KROHNE illustration. The other six were Facebook/Instagram crawler re-hosts,
// now blocked by domain instead (fbsbx.com added above), which is where that
// judgement belongs.
//
// Wikimedia keeps its extension check: there the URL is the original filename
// and the extension carries real meaning (.svg proves a vector diagram).
function isUsableWebImageUrl(rawUrl: string): boolean {
  return /^https?:\/\//i.test(rawUrl);
}

// ── SerpAPI (optional, paid, preferred provider) ─────────────────────────────
//
// serpapi.com's google_images engine, distinct from serper.dev below. Preferred
// because its results carry the image's real dimensions, which lets the same
// minimum-width rule that protects Commons results apply here too — a 90px
// thumbnail matches a query just as well as a 1600px schematic and looks like
// mush on a projector.
//
//   SERPAPI_API_KEY = key from serpapi.com
//
// Falls back to Serper when unset, so nothing changes until the key exists.
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY ?? "";

// SerpAPI plans are rate-limited per hour (250/hr on the current plan, and this
// code spends up to MAX_WEB_QUERIES_PER_SCAN per scan). When several teachers
// scan at once that ceiling is reachable — and without this, a 429 meant the
// scan simply got no web images, despite a working Serper key sitting right
// there. Tripping this cooldown makes provider selection fall through to the
// next configured provider until SerpAPI is worth trying again.
const SERPAPI_TBS_FILTERS = "isz:l";

const SERPAPI_COOLDOWN_MS = 5 * 60 * 1000;
let serpApiUnavailableUntil = 0;

function markSerpApiUnavailable(reason: string): void {
  serpApiUnavailableUntil = Date.now() + SERPAPI_COOLDOWN_MS;
  console.warn(
    `[blackboard] SerpAPI unavailable (${reason}) — falling back to the next provider for ` +
    `${SERPAPI_COOLDOWN_MS / 60000} minutes`
  );
}

/** True when SerpAPI is configured and not in a rate-limit cooldown. */
function isSerpApiUsable(): boolean {
  return !!SERPAPI_API_KEY && Date.now() >= serpApiUnavailableUntil;
}

async function fetchSerpApiImages(
  query: string,
  limit: number,
  seenUrls: Set<string>,
  illustrationsOnly = false
): Promise<{ url: string; caption: string }[]> {
  if (!SERPAPI_API_KEY || limit <= 0) return [];
  const params = new URLSearchParams({
    engine: "google_images",
    q: query,
    api_key: SERPAPI_API_KEY,
    // Google's own SafeSearch. Not sufficient on its own for a children's
    // product — clinical anatomy passes it — which is why every result still
    // goes through isClassroomSafe below.
    safe: "active",
    ijn: "0",
    // Google's own "large images" filter. This is the highest-leverage quality
    // change available: measured on "nuclear power plant schematic diagram",
    // results at 800px or wider went from 44/100 to 99/100 — and because the
    // filter runs at Google's end, we still receive a full 100 candidates, so
    // quality rises without costing quantity.
    //
    // Deliberately NOT using itp:lineart alongside it. It sounds ideal for
    // "give me diagrams", but measured worse: images shrank to ~450px and it
    // surfaced Craiyon AI art. Google's line-art classifier is not selecting
    // for teaching diagrams.
    tbs: SERPAPI_TBS_FILTERS,
  });

  try {
    const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[blackboard] SerpAPI image search returned ${res.status} for "${query}"`);
      // 429 = hourly rate limit, 401/403 = bad or exhausted key. All three mean
      // "stop asking for a while" rather than "this query had no results".
      if (res.status === 429 || res.status === 401 || res.status === 403) {
        markSerpApiUnavailable(`HTTP ${res.status}`);
      }
      return [];
    }
    const json = (await res.json()) as {
      error?: string;
      images_results?: Array<{
        title?: string;
        original?: string;
        original_width?: number;
        original_height?: number;
        /** Publisher name, e.g. "Britannica" — better provenance than the CDN host. */
        source?: string;
        /** The PAGE the image sits on, which the image host often hides behind a CDN. */
        link?: string;
        /** Shopping results: product photography, never teaching material. */
        is_product?: boolean;
      }>;
    };
    if (json.error) {
      console.error(`[blackboard] SerpAPI returned an error for "${query}": ${json.error}`);
      // SerpAPI reports quota problems as HTTP 200 with an `error` string, so
      // the status check above never sees them.
      if (/rate|limit|quota|exceed|plan|credit/i.test(json.error)) {
        markSerpApiUnavailable(json.error.slice(0, 80));
      }
      return [];
    }

    const preferred: { url: string; caption: string }[] = [];
    const other: { url: string; caption: string }[] = [];

    for (const item of json.images_results ?? []) {
      if (preferred.length + other.length >= limit * 3) break;
      const url = item.original;
      if (!url || seenUrls.has(url)) continue;
      if (!isUsableWebImageUrl(url)) continue;
      // Shopping results are product photography — never a teaching visual.
      if (item.is_product) continue;
      // Dimensions are the reason this provider is preferred — use them.
      if (item.original_width && item.original_width < MIN_WEB_IMAGE_WIDTH) continue;
      // Check BOTH the image host and the page it came from. A CDN host
      // (media.hswstatic.com, lookaside.fbsbx.com) hides who actually published
      // it, so blocking on the image URL alone missed re-hosts and ranking on
      // it alone missed genuine educational publishers behind a CDN.
      if (isBlockedImageSource(url)) continue;
      if (item.link && isBlockedImageSource(item.link)) continue;
      const title = item.title ?? "";
      if (illustrationsOnly && !isIllustration(title, url)) continue;
      if (!isClassroomSafe(title, url)) continue;
      const fromPreferredSource =
        isPreferredImageSource(url) || (!!item.link && isPreferredImageSource(item.link));
      // The publisher name rides along in the caption. It costs almost nothing
      // and gives the relevance step real provenance to weigh — "Britannica"
      // and "Vedantu" mean something that a bare CDN filename does not.
      const publisher = item.source?.trim();
      const caption = title.trim() || query;
      (fromPreferredSource ? preferred : other).push({
        url,
        caption: publisher && !caption.includes(publisher) ? `${caption} — ${publisher}` : caption,
      });
    }

    const out = [...preferred, ...other].slice(0, limit);
    for (const img of out) seenUrls.add(img.url);
    return out;
  } catch (err) {
    console.error(`[blackboard] SerpAPI image search failed for "${query}":`, err);
    return [];
  }
}

async function fetchSerperImages(
  query: string,
  limit: number,
  seenUrls: Set<string>,
  illustrationsOnly = false
): Promise<{ url: string; caption: string }[]> {
  if (!SERPER_API_KEY || limit <= 0) return [];
  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      // Ask for more than needed — the domain allowlist rejects most results,
      // so a tight `num` would usually come back empty.
      body: JSON.stringify({ q: query, num: 40, safe: "active" }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      console.error(`[blackboard] Serper image search returned ${res.status} for "${query}"`);
      return [];
    }
    const json = (await res.json()) as {
      images?: Array<{ title?: string; imageUrl?: string; link?: string; domain?: string }>;
    };
    // Two passes: collect everything acceptable, tagging whether it came from a
    // preferred educational source, then emit preferred first. Ranking rather
    // than filtering means a Britannica or Wikimedia diagram outranks a random
    // blog, without excluding subjects (CS especially) that only the wider web
    // covers.
    const preferred: { url: string; caption: string }[] = [];
    const other: { url: string; caption: string }[] = [];

    for (const item of json.images ?? []) {
      if (preferred.length + other.length >= limit * 3) break;
      const url = item.imageUrl;
      if (!url || seenUrls.has(url)) continue;
      if (!isUsableWebImageUrl(url)) continue;
      // Judge the image's own host, not the `domain` field — that describes the
      // page the image was found on, and an untrusted site can hot-link a
      // trusted image (or the reverse).
      if (isBlockedImageSource(url)) continue;
      const title = item.title ?? "";
      if (illustrationsOnly && !isIllustration(title, url)) continue;
      if (!isClassroomSafe(title, url)) continue;
      (isPreferredImageSource(url) ? preferred : other).push({
        url,
        caption: title.trim() || query,
      });
    }

    const out = [...preferred, ...other].slice(0, limit);
    for (const img of out) seenUrls.add(img.url);
    return out;
  } catch (err) {
    console.error(`[blackboard] Serper image search failed for "${query}":`, err);
    return [];
  }
}

// ── Google Programmable Search (optional, paid, alternative to Serper) ────────
//
// Kept as a switchable alternative: it does support a usage-rights filter,
// which Serper lacks. Whichever is configured gets used; Serper wins if both.
// Enabled only when both env vars are set, so the feature degrades cleanly to
// Wikipedia-only when unconfigured.
//
//   GOOGLE_SEARCH_API_KEY = Google Cloud API key with Custom Search API enabled
//   GOOGLE_SEARCH_CX      = Programmable Search Engine ID, configured with
//                           "Image search" ON and "Search the entire web" ON
//
// `rights` restricts results to openly-licensed images. That matters for a
// commercial product: unrestricted web image results carry real copyright
// exposure, and this filter is the difference between "reusable" and "risky".
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_CX = process.env.GOOGLE_SEARCH_CX;
const GOOGLE_IMAGE_LICENSE_FILTER = "cc_publicdomain|cc_attribute|cc_sharealike";

async function fetchGoogleImages(
  query: string,
  limit: number,
  seenUrls: Set<string>,
  illustrationsOnly = false
): Promise<{ url: string; caption: string }[]> {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_CX || limit <= 0) return [];
  try {
    const params = new URLSearchParams({
      key: GOOGLE_SEARCH_API_KEY,
      cx: GOOGLE_SEARCH_CX,
      q: query,
      searchType: "image",
      // Drop "photo" for sensitive subjects so the API itself excludes
      // photographic results, rather than relying only on our own filtering.
      imgType: illustrationsOnly ? "clipart|lineart" : "clipart|lineart|photo",
      // Same reasoning as SERPAPI_TBS_FILTERS — filter for size at the API,
      // where it costs no candidates, rather than discarding small results here.
      imgSize: "large",
      safe: "active",
      rights: GOOGLE_IMAGE_LICENSE_FILTER,
      num: String(Math.min(limit * 2, 10)),
    });
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params.toString()}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`[blackboard] Google image search returned ${res.status} for "${query}"`);
      return [];
    }
    const json = (await res.json()) as {
      items?: Array<{ title?: string; link?: string; mime?: string }>;
    };
    const IMAGE_EXT = /\.(jpg|jpeg|png|svg|gif|webp)(?:\?.*)?$/i;
    const out: { url: string; caption: string }[] = [];
    for (const item of json.items ?? []) {
      if (out.length >= limit) break;
      const url = item.link;
      if (!url || seenUrls.has(url)) continue;
      // Guard against results whose link isn't actually a directly-renderable
      // image (CSE occasionally returns page URLs for embedded media).
      if (!IMAGE_EXT.test(url) && !(item.mime ?? "").startsWith("image/")) continue;
      // Belt-and-braces: imgType above should already exclude photos, but the
      // filter is advisory and the stakes here don't justify trusting it alone.
      if (illustrationsOnly && !isIllustration(item.title ?? "", url)) continue;
      if (!isClassroomSafe(item.title ?? "", url)) continue;
      seenUrls.add(url);
      out.push({ url, caption: item.title?.trim() || query });
    }
    return out;
  } catch (err) {
    console.error(`[blackboard] Google image search failed for "${query}":`, err);
    return [];
  }
}

// ── Stage 4: concept-driven image retrieval ───────────────────────────────────
//
// Searches the *concepts extracted from the document* rather than the teacher's
// raw prompt. A prompt like "give me images" carries no searchable signal;
// "Chloroplast", "Calvin cycle" do. Issuing one query per suggested visual also
// raises hit rate substantially over the previous single-query approach — if
// one concept has no good imagery, the others still return something relevant.
//
// Source order encodes the cost policy: Wikipedia first (free, curated,
// precisely matched), Google CSE only to fill the shortfall (paid per query,
// so it runs on the smallest number of queries that can close the gap).
// Teaching material benefits from breadth — a teacher wants every usable
// schematic, not an arbitrary five. Bounded only by what's sane to send in one
// response and render in a side panel.
const MAX_IMAGES_PER_SCAN = 40;
// Hard ceiling on paid queries per scan, independent of the image target.
const MAX_WEB_QUERIES_PER_SCAN = 5;
// Once Wikipedia has produced this many diagrams the result is already good
// enough to teach from, so paid search is skipped. Without this the top-up
// condition compares against the 24-image ceiling, which Wikipedia never
// reaches — meaning every single scan would spend credits.
const ENOUGH_DIAGRAMS_WITHOUT_WEB = 6;
// Animations are the standout classroom asset but also the scarcest, so this
// caps the effort spent hunting for them rather than the value of having them.
const MAX_ANIMATIONS_PER_SCAN = 6;
const MAX_ANIMATION_QUERIES = 4;
// Commons is free but not instant (~0.3s a call, issued sequentially). The
// subject pass multiplies qualifiers by concepts, so without a ceiling a
// topic that finds nothing would spend 20+ round trips before giving up.
const MAX_COMMONS_LOOKUPS = 10;
// Image results are cached against the concept queries, so a teacher
// re-scanning the same pages (tweaking instructions, switching summary/notes)
// costs nothing further.
const IMAGE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

// When the teacher explicitly asks for a diagram/schematic, Wikipedia is the
// wrong source to lead with: its articles are photo-heavy (the "Cooling tower"
// article is all photographs of real towers), and those fill the slots before
// any diagram search runs. Web search is far better at this specific job, so
// for a diagram-seeking instruction it goes first rather than acting as top-up.
const DIAGRAM_REQUEST_PATTERN =
  /\b(diagram|schematic|labell?ed|illustration|figure|drawing|sketch|blueprint|chart|flow ?chart|cross[- ]?section|layout)\b/i;

// The mirror case: plenty of subjects are best taught with the real thing —
// a photograph of a monument, a satellite view, a microscope image, an actual
// specimen. Diagram-first ranking would actively work against those, so an
// explicit request for photos inverts it.
const PHOTO_REQUEST_PATTERN =
  /\b(photo|photos|photograph\w*|real|actual|realistic|picture[sd]? of|satellite|aerial|microscope|micrograph|specimen|looks? like|live)\b/i;

// ── Relevance selection ───────────────────────────────────────────────────────
//
// The step that was missing entirely. Retrieval finds images ABOUT A CONCEPT;
// it has no idea what the teacher's pages actually say. A Wikipedia article
// covers its whole subject, and its media list is ordered by where images
// appear in the article — so "Chordate" leads with a glass catfish, a hagfish
// and a lancelet regardless of whether the lesson is about classification,
// anatomy or evolution. Taking the first N in article order is why images kept
// coming back "about the right topic but not about this material".
//
// So: gather a WIDE pool of candidates, then have the model choose which of
// them genuinely illustrate the lesson that was just generated — matching each
// caption against the scan's own overview and key points. Captions are short,
// so this is a small call (a 48-image pool is roughly 700 input tokens) next to
// the scan itself.
//
// Fails open: any error, refusal or unusable response leaves the original
// ordering untouched. Image relevance must never be able to fail a scan.
// Larger than MAX_IMAGES_PER_SCAN so the selector has something to filter —
// relevance comes from the RATIO, not the raw count. Was 120 (discarding two
// of every three candidates at 40 returned); cut to 60 to roughly halve the
// ranking call's input tokens (~2.7k -> ~1.5k per scan), accepting that the
// selector now discards about one in three at the 40-image ceiling, and that
// a candidate ranked 61st+ in retrieval order is never considered.
const IMAGE_POOL_SIZE = 60;
// Fraction of the pool Wikipedia articles may fill; the remainder is held for
// web search, Commons and animations.
const ARTICLE_POOL_SHARE = 0.55;
// The tail of a long caption rarely changes the judgement.
const MAX_CAPTION_CHARS = 85;
// How many candidates the one retry falls back to after a completion-budget
// failure — half the pool, so the retry still triggers (it only fires when
// the pool is larger than this).
const SELECTOR_RETRY_CANDIDATES = 30;

async function selectRelevantImages(
  candidates: { url: string; caption: string }[],
  lessonSummary: string,
  instructions: string | undefined,
  limit: number,
  usage: { institutionId: string; teacherId: string; userId: string },
  previouslyShown?: string[],
  /** Retry depth — bounds the single shorter-list retry below. */
  depth = 0,
): Promise<{ url: string; caption: string }[] | null> {
  if (!openai) return null;
  // Nothing to choose between — ranking would cost a call and change nothing.
  if (candidates.length <= 3 || !lessonSummary.trim()) return null;

  const numbered = candidates
    .map((c, i) => `${i}: ${c.caption.replace(/\s+/g, " ").slice(0, MAX_CAPTION_CHARS)}`)
    .join("\n");

  const systemPrompt =
    "You are helping a schoolteacher choose which images to project onto the classroom board for one specific lesson. " +
    "You will be given what the lesson actually teaches, then a numbered list of available images described by their captions. " +
    "Select ONLY the images that genuinely illustrate THIS lesson's content. " +
    "Reject anything that merely belongs to the same broad subject — a picture of one example species does not illustrate a lesson about how organisms are classified. " +
    "Reject GENERIC images in particular: a lesson about hydroelectric power stations needs dams, turbines and generators, NOT abstract 'energy conversion' or 'energy transformation' diagrams that would suit any physics lesson at all. " +
    "If a caption would fit equally well in a dozen unrelated lessons, it does not belong in this one. " +
    "When the teacher has given instructions, they are the FIRST filter: an image that does not serve what they asked for is rejected no matter how well it matches the topic. " +
    "Some captions end with the publisher after a dash (e.g. \"... — Britannica\"). Treat that as a quality signal: an established reference, textbook or academic publisher is more likely to be an accurate, clearly-drawn teaching visual than an unknown blog, though a good image from an unknown source still beats a poor one from a known publisher. " +
    "Reject decorative photographs, portraits of unrelated people, logos, maps that show nothing the lesson mentions, and images whose caption you cannot connect to the lesson. " +
    "Order your selection best-first: the image you would put on the board first comes first. " +
    "KEEP EVERY image that genuinely illustrates the lesson — a teacher wants the full set of usable visuals, so do not stop at a handful when twenty are genuinely good. " +
    "But never pad: there is no target number, and an image you cannot confidently connect to this lesson must be rejected even if that leaves only three. " +
    "Judge each candidate on its own merit, not against a quota. " +
    'Return ONLY valid JSON: {"keep": [<indices, best first>]}. No markdown, no explanation.';

  const userContent =
    `WHAT THIS LESSON TEACHES:\n${lessonSummary}\n` +
    (instructions
      ? `\nTEACHER'S INSTRUCTIONS — THE PRIMARY SELECTION CRITERION. Judge every candidate against this first, and only then against the lesson content:\n"${instructions}"\n`
      : "") +
    (previouslyShown?.length
      ? `\nSHOWN ON THE PREVIOUS SCAN OF THIS MATERIAL:\n${previouslyShown.slice(0, 24).map(c => `- ${c.slice(0, MAX_CAPTION_CHARS)}`).join("\n")}\n` +
        `The teacher scanned again because they want better visuals than these. Prefer candidates that illustrate the lesson more directly than what was shown before. ` +
        `Keep one of the previous images only where it is genuinely among the best available — do not drop a strong image just because it appeared last time, and do not pick a weaker one merely to be different.\n`
      : "") +
    `\nAVAILABLE IMAGES:\n${numbered}\n\nReturn at most ${limit} indices.`;

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      // Sized for REASONING, not for the answer. The answer is ~40 integers
      // (a couple of hundred tokens), but Groq's gpt-oss models emit hidden
      // reasoning tokens first and those count against this budget — at 700
      // the model ran out mid-JSON and Groq rejected the whole call with
      // `json_validate_failed: max completion tokens reached before generating
      // a valid document`, losing relevance selection for the entire scan.
      max_tokens: 2500,
      ...(AI_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
    });
  } catch (err) {
    await recordAiUsage({
      ...usage, userRole: "TEACHER",
      feature: "BLACKBOARD_IMAGE_RANK" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
      requestType: "chat_completion", status: "FAILED",
      error: err instanceof Error ? err.message : String(err),
    });

    // A budget/validation failure scales with how many captions the model had
    // to weigh, so retry once on a shorter list rather than dropping relevance
    // selection for the whole scan. Anything else (auth, rate limit, network)
    // will fail again identically, so only this case is retried.
    const message = err instanceof Error ? err.message : String(err);
    const isBudgetFailure = /json_validate_failed|max completion tokens|Failed to generate JSON/i.test(message);
    if (isBudgetFailure && candidates.length > SELECTOR_RETRY_CANDIDATES && depth === 0) {
      console.warn(
        `[blackboard] Relevance selection hit the completion budget on ${candidates.length} candidates — ` +
        `retrying with ${SELECTOR_RETRY_CANDIDATES}`
      );
      return selectRelevantImages(
        candidates.slice(0, SELECTOR_RETRY_CANDIDATES),
        lessonSummary, instructions, limit, usage, previouslyShown, depth + 1
      );
    }
    console.error("[blackboard] Image relevance selection failed — keeping retrieval order:", message);
    return null;
  }

  await recordAiUsage({
    ...usage, userRole: "TEACHER",
    feature: "BLACKBOARD_IMAGE_RANK" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
    requestType: "chat_completion", status: "SUCCESS",
    inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
    totalTokens: completion.usage?.total_tokens,
  });

  let keep: unknown;
  try {
    keep = (JSON.parse(completion.choices[0].message.content ?? "{}") as { keep?: unknown }).keep;
  } catch {
    console.error("[blackboard] Image relevance selection returned malformed JSON — keeping retrieval order");
    return null;
  }
  if (!Array.isArray(keep)) return null;

  // Indices are model output, so treat them as untrusted: drop anything that
  // isn't a real position in the pool, and de-duplicate.
  const seen = new Set<number>();
  const chosen: { url: string; caption: string }[] = [];
  for (const raw of keep) {
    const i = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length || seen.has(i)) continue;
    seen.add(i);
    chosen.push(candidates[i]);
    if (chosen.length >= limit) break;
  }
  // An empty selection means the model rejected everything. That is a real
  // signal on a pool of loosely-related images, but returning nothing would
  // leave the teacher with a blank panel, so fall back rather than trust it.
  if (chosen.length === 0) {
    console.log("[blackboard] Image relevance selection kept nothing — falling back to retrieval order");
    return null;
  }
  return chosen;
}

interface ConceptImageOptions {
  limit: number;
  rawText?: string;
  instructions?: string;
  /** The scan's own overview + key points — what relevance is judged against. */
  lessonSummary?: string;
  usage?: { institutionId: string; teacherId: string; userId: string };
  /** Captions shown on the previous scan of this material, if any. */
  previousImageCaptions?: string[];
  /** Refinement pass number; >0 bypasses the image cache so results can improve. */
  refinementPass?: number;
}

async function retrieveConceptImages(
  context: DocumentContext,
  options: ConceptImageOptions
): Promise<{ url: string; caption: string }[]> {
  const { limit, rawText, instructions, lessonSummary, usage, previousImageCaptions, refinementPass } = options;
  const isRefinement = (refinementPass ?? 0) > 0;
  // Retrieval gathers a deliberately WIDE pool so the relevance step below has
  // something to choose between; without it, "take the first N in article
  // order" IS the selection, which is the whole problem.
  const poolTarget = lessonSummary && usage ? Math.max(limit, IMAGE_POOL_SIZE) : limit;
  // Most specific first: explicit visual suggestions, then subtopics, then the
  // broad topic as a backstop. Deduped so a concept repeated across fields
  // doesn't consume two search slots.
  const queries = [...new Set(
    [...context.suggestedVisuals, ...context.subtopics, context.topic]
      .map(q => q.trim())
      .filter(Boolean)
  )];
  if (queries.length === 0) return [];

  // Anatomy/reproduction and similar subjects: diagrams only, no photographs.
  // Deliberately fails closed — if filtering leaves nothing, the scan returns
  // no images rather than falling back to unfiltered results.
  const sensitiveTerm = isSensitiveSubject(context, rawText);
  const illustrationsOnly = sensitiveTerm !== null;
  // What counts as a good visual is subject-dependent — see SUBJECT_VISUAL_PROFILE.
  const profile = SUBJECT_VISUAL_PROFILE[context.subject ?? "general"] ?? SUBJECT_VISUAL_PROFILE.general;
  console.log(
    `[blackboard] Image retrieval — topic="${context.topic}" subject=${context.subject ?? "general"} ` +
    `sensitive=${illustrationsOnly}${sensitiveTerm ? ` (matched "${sensitiveTerm}")` : ""} ` +
    `queries=${JSON.stringify(queries.slice(0, 6))}`
  );

  // Keyed by the concepts searched plus the intent, so re-scanning the same
  // pages — or flipping between summary and notes — reuses the result instead
  // of re-spending search credits. Different instructions that produce
  // different queries or a different intent naturally miss and re-search.
  const imageCacheKey = `blackboard:imgs:${crypto
    .createHash("sha256")
    .update(
      `${queries.join("|")}::${context.subject ?? "general"}::v3::${illustrationsOnly}::` +
      `${instructions ?? ""}::${limit}::${lessonSummary ?? ""}`
    )
    .digest("hex")
    .slice(0, 32)}`;
  // A refinement pass must never be served from cache — returning the same
  // images is precisely what the teacher re-scanned to get away from.
  const cachedImages = isRefinement
    ? null
    : await getCache<{ url: string; caption: string }[]>(imageCacheKey);
  if (cachedImages) {
    console.log(`[blackboard] Image cache hit — ${cachedImages.length} image(s), no search performed`);
    return cachedImages;
  }

  const seenUrls = new Set<string>();
  // Provider order: SerpAPI first (it reports image dimensions, so the
  // minimum-width rule applies), Serper next, Google CSE last. Each is used
  // only when its key is present, so the order degrades cleanly.
  const serpApiUsable = isSerpApiUsable();
  const webSearch = serpApiUsable
    ? fetchSerpApiImages
    : (SERPER_API_KEY ? fetchSerperImages : fetchGoogleImages);
  const webSearchAvailable = serpApiUsable || !!SERPER_API_KEY || !!GOOGLE_SEARCH_API_KEY;
  const webProvider = serpApiUsable
    ? "serpapi"
    : (SERPER_API_KEY ? "serper" : (GOOGLE_SEARCH_API_KEY ? "google-cse" : "none"));
  // An explicit photo request wins over the diagram-first default — but only
  // when diagrams weren't also asked for ("labelled photo of a real leaf").
  const wantsDiagrams = !!instructions && DIAGRAM_REQUEST_PATTERN.test(instructions);
  const wantsPhotos = !!instructions && !wantsDiagrams && PHOTO_REQUEST_PATTERN.test(instructions);

  const animations: { url: string; caption: string }[] = [];
  const diagrams: { url: string; caption: string }[] = [];
  const photos: { url: string; caption: string }[] = [];
  const sortInto = (imgs: { url: string; caption: string }[]) => {
    for (const img of imgs) {
      // Belt-and-braces: each source already applies isClassroomSafe, but this
      // is the single point every image funnels through before reaching a
      // classroom, so re-check rather than assume no future source skips it.
      if (!isClassroomSafe(img.caption, img.url)) continue;
      const isDiagram = isIllustration(img.caption, img.url);
      // On a sensitive subject anything not identifiable as a diagram is
      // dropped outright rather than kept as a lower-ranked photo — the
      // photos array is what later fills spare slots, so keeping it would
      // reintroduce exactly what the illustrations-only mode exists to prevent.
      // Note this uses isIllustration, NOT isAnimation: a bare GIF still fails
      // the strict gate here, so animations get no free pass on these topics.
      if (illustrationsOnly && !isDiagram) continue;
      if (isAnimation(img.caption, img.url)) animations.push(img);
      else if (isDiagram) diagrams.push(img);
      else photos.push(img);
    }
  };
  // Counted together wherever the code asks "do we have enough teaching
  // visuals yet" — an animation satisfies that need at least as well as a
  // static diagram does.
  const visualCount = () => animations.length + diagrams.length;

  // Reuse the teacher's own wording for the search when they asked for a
  // specific kind of visual — "schematic diagram of a nuclear power plant"
  // finds far better results than a generic "<topic> labelled diagram".
  const diagramQualifier = wantsDiagrams || wantsPhotos ? instructions!.trim() : profile.webQualifier;
  // Guarded so the two call sites below can never double-spend the budget.
  let webSearchRan = false;
  const runWebSearch = async () => {
    if (!webSearchAvailable || webSearchRan) return;
    webSearchRan = true;
    let spent = 0;
    for (const query of queries) {
      if (visualCount() >= poolTarget || spent >= MAX_WEB_QUERIES_PER_SCAN) break;
      spent++;
      sortInto(await webSearch(`${query} ${diagramQualifier}`, poolTarget - visualCount(), seenUrls, illustrationsOnly));
    }
  };

  // Free tier between article images and paid search. Wikipedia *articles*
  // only surface the handful of images an editor chose to embed; Commons is
  // the full media repository behind them and holds far more diagrams —
  // "nuclear power plant diagram" returns 15 schematics there while the
  // article itself has almost none. Relevance is enforced by requiring every
  // meaningful query keyword in the title/caption, since Commons full-text
  // search otherwise matches words independently ("system" + "diagram"
  // surfacing an unrelated Cromemco block diagram).
  const runCommonsSearch = async () => {
    // Qualifiers come from the subject profile and are tried in order: a
    // History concept searches "painting", then "portrait", then "photograph",
    // where the old code searched "<concept> diagram" for every subject alike
    // and returned schematics nobody asked for.
    let lookups = 0;
    for (const qualifier of profile.commonsQualifiers) {
      for (const query of queries) {
        if (visualCount() >= limit || lookups >= MAX_COMMONS_LOOKUPS) break;
        lookups++;
        sortInto(await fetchWikimediaImages(
          `${query} ${qualifier}`,
          limit - visualCount(),
          keywordsOf(query), // qualifier excluded, or it would be required in every title
          illustrationsOnly,
          seenUrls,
        ));
      }
      if (visualCount() >= ENOUGH_DIAGRAMS_WITHOUT_WEB || lookups >= MAX_COMMONS_LOOKUPS) break;
    }
  };

  // A dedicated pass for animated teaching assets. Without it a GIF was only
  // ever found by accident — no query asked for one, and Commons ranks them
  // below static files for a plain topic search. Free (Commons only), and
  // skipped for subjects where an animation isn't the point.
  const runAnimationSearch = async () => {
    if (!profile.wantsAnimation) return;
    for (const query of queries.slice(0, MAX_ANIMATION_QUERIES)) {
      if (animations.length >= MAX_ANIMATIONS_PER_SCAN) break;
      const found = await fetchWikimediaImages(
        `${query} animation`,
        MAX_ANIMATIONS_PER_SCAN - animations.length,
        keywordsOf(query),
        illustrationsOnly,
        seenUrls,
      );
      // Commons returns plenty of static files for an "animation" query too;
      // keep only what is actually animated, and hand the rest back to the
      // normal buckets rather than discarding a good diagram we already paid
      // the round trip for.
      sortInto(found);
    }
  };

  // Sensitive subjects never touch general web search. On Wikimedia we can
  // judge an image structurally — SVG is necessarily a drawing, and the
  // illustration libraries are known — but a web result offers only a title,
  // and a clinical photograph called "Female reproductive organs anatomy"
  // satisfies both the illustration hint ("anatomy") and the explicit-word
  // backstop (no explicit term present). There is no reliable title-based
  // test, so the source itself is restricted instead.
  const allowWebSearch = webSearchAvailable && !illustrationsOnly;
  if (illustrationsOnly && webSearchAvailable) {
    console.log("[blackboard] Sensitive subject — restricted to Wikimedia diagrams, web image search disabled");
  }

  // Free sources are always exhausted before any paid query, even when the
  // teacher explicitly asked for diagrams — Commons turns out to cover most
  // school topics well, so paid search becomes the exception rather than the
  // rule.
  // poolTarget, not `limit`: one media-list request already returns every image
  // in the article, so taking more of them costs no extra HTTP call — it just
  // stops throwing away candidates the relevance step could have chosen from.
  // Commons and web search below stay bound by `limit`, so a wider pool never
  // spends additional paid queries.
  // When the teacher explicitly asked for a diagram or schematic, web search
  // LEADS rather than tops up. Wikipedia articles are photo-heavy and their
  // titles are subjects, not schematics — asking it for "a schematic diagram of
  // a nuclear power plant" returns the Nuclear power plant article's
  // photographs of cooling towers. Google Images is far better at this exact
  // job. The comment on DIAGRAM_REQUEST_PATTERN has claimed this behaviour for
  // a while; it was never actually wired up.
  if (wantsDiagrams && allowWebSearch) {
    console.log(`[blackboard] Instruction asks for diagrams — leading with ${webProvider} rather than Wikipedia`);
    await runWebSearch();
  }

  // Capped share, not the whole pool. Wikipedia articles are image-rich (the
  // Nuclear power plant article alone has 17), so letting them fill all 120
  // slots would starve the sources that are actually on-target for a specific
  // lesson. Reserving the rest guarantees web and Commons results reach the
  // selector rather than arriving after the pool is already full.
  sortInto(await fetchTopicImages(
    queries, Math.round(poolTarget * ARTICLE_POOL_SHARE), seenUrls, illustrationsOnly
  ));
  if (!(wantsPhotos && !illustrationsOnly) && visualCount() < ENOUGH_DIAGRAMS_WITHOUT_WEB) {
    // Photos requested: article images are the better free source (Commons
    // search is qualified toward diagrams/paintings), so that pass is skipped.
    const beforeCommons = visualCount();
    await runCommonsSearch();
    console.log(`[blackboard] Commons search (free): ${beforeCommons} -> ${visualCount()} visual(s)`);
  }

  // Always worth a look, even when static visuals are already plentiful — an
  // animation of the process is the asset students actually remember.
  const beforeAnimations = animations.length;
  await runAnimationSearch();
  if (animations.length > beforeAnimations) {
    console.log(`[blackboard] Animation search (free): found ${animations.length} animated visual(s)`);
  }

  // Web search now runs on EVERY scan a provider is configured for, not only
  // when free sources fall short.
  //
  // The old shortfall rule made sense when the last image in the list was the
  // one shown; it does not now that a relevance step chooses from a pool. Free
  // sources were reaching the "enough" threshold with generic article images
  // and suppressing the search that would have found the actual teaching
  // diagram — Wikipedia articles are written for an encyclopedia, and Google
  // Images has far better coverage of school-appropriate schematics. Feeding
  // both into the pool lets the selector pick on merit.
  //
  // COST: bounded by MAX_WEB_QUERIES_PER_SCAN (3) per scan, but it is now
  // spent on every scan rather than occasionally. To restore the old
  // behaviour, gate this on `visualCount() < ENOUGH_DIAGRAMS_WITHOUT_WEB`.
  if (allowWebSearch) {
    console.log(
      `[blackboard] Free sources gave ${diagrams.length} diagram(s), ${animations.length} animation(s), ` +
      `${photos.length} photo(s) — adding ${webProvider} results (max ${MAX_WEB_QUERIES_PER_SCAN} queries)`
    );
    await runWebSearch();
  }

  if (!webSearchAvailable) {
    // Surfaced explicitly because the symptom (only Wikipedia photos) looks
    // identical to a relevance bug, but the cause is a missing key — usually a
    // process started before SERPER_API_KEY was added to .env.
    console.warn("[blackboard] No web image provider configured (SERPAPI_API_KEY / SERPER_API_KEY / GOOGLE_SEARCH_API_KEY) — Wikipedia only.");
  }

  // Diagrams lead by default because that's what teaching material usually
  // needs — but photos still fill the remaining slots rather than being capped,
  // otherwise subjects that legitimately have no diagrams (a monument, a
  // historical figure, a landscape) would come back nearly empty.
  // Animations lead: they are the scarcest and the most engaging, and there
  // at most MAX_ANIMATIONS_PER_SCAN of them lead (see the cap below), so they
  // can never crowd out the static visuals. After that the subject decides — a History or
  // Geography lesson wants the photograph first, a Biology lesson the diagram
  // — unless the teacher's own instruction overrides it.
  const photosFirst = wantsPhotos || (!wantsDiagrams && profile.photosAreTheGoal && !illustrationsOnly);
  const [first, second] = photosFirst ? [photos, diagrams] : [diagrams, photos];
  // Each bucket preserves fetchTopicImages' round-robin order, so the concepts
  // the scan identified stay interleaved rather than being re-sorted here.
  //
  // The cap is applied HERE, not just in runAnimationSearch: article-embedded
  // GIFs arrive through sortInto without passing that loop's bound, and some
  // articles are animation-rich (the physics set measures 30 across four
  // concepts). Since animations lead the result, an uncapped bucket would fill
  // every slot and leave the lesson with no diagrams at all. The remainder
  // still rank after the static visuals rather than being discarded.
  const leadAnimations = animations.slice(0, MAX_ANIMATIONS_PER_SCAN);
  const extraAnimations = animations.slice(MAX_ANIMATIONS_PER_SCAN);
  const pool = [...leadAnimations, ...first, ...second, ...extraAnimations];

  // ── The relevance step ──────────────────────────────────────────────────
  // Everything above ranks by TYPE and by where an image sat in its source
  // article. Neither has any idea what the teacher's pages actually say, which
  // is why results kept being "about the topic" without being about the
  // lesson. This is the only stage that compares a candidate against the
  // material, so it decides the final order; retrieval order is the fallback.
  let result = pool.slice(0, limit);
  let selectionNote = "";
  // No pool-size gate beyond selectRelevantImages' own (it skips pools of 3 or
  // fewer). Even a small pool benefits: dropping two loosely-related images is
  // worth more to a lesson than padding the panel out to the limit.
  if (lessonSummary && usage) {
    const selected = await selectRelevantImages(
      pool.slice(0, IMAGE_POOL_SIZE), lessonSummary, instructions, limit, usage,
      isRefinement ? previousImageCaptions : undefined
    );
    if (selected) {
      result = selected;
      selectionNote = ` — AI kept ${selected.length} of ${Math.min(pool.length, IMAGE_POOL_SIZE)} candidates as relevant to the lesson`;
    }
  }

  console.log(
    `[blackboard] Returning ${result.length} image(s) from a pool of ${pool.length} — ` +
    `${animations.length} animation(s), ${diagrams.length} diagram(s), ${photos.length} photo(s)` +
    `${photosFirst ? ` (photos first: ${wantsPhotos ? "per instruction" : `${context.subject} subject`})` : ""}` +
    selectionNote
  );
  // Only cache a non-empty result: an empty one usually means a transient
  // failure (timeout, rate limit) and caching it would pin the emptiness for
  // a week.
  if (result.length > 0) await setCache(imageCacheKey, result, IMAGE_CACHE_TTL_SECONDS);
  return result;
}

// ── Stage 2: document context ─────────────────────────────────────────────────
//
// A structured understanding of the selected pages, derived once and reused.
// Deliberately kept INSTRUCTION-INDEPENDENT: the same pages produce the same
// context no matter what the teacher asks, which is what makes it cacheable.
// Instruction-specific output (Stage 3) is generated separately on top of it.
//
// Cost shape: a cache miss costs two model calls (context + generation), a hit
// costs one. Since teachers re-scan the same pages repeatedly — tweaking
// instructions, switching between summary and notes — this amortises quickly,
// and the expensive part (reading the full page text) is paid at most once.

export interface DocumentContext {
  topic: string;
  subtopics: string[];
  keywords: string[];
  definitions: { term: string; meaning: string }[];
  conceptType: string;
  /** School subject, from MINDMAP_SUBJECTS — selects the image-search strategy. */
  subject: MindmapSubject;
  /** Concrete things worth picturing, phrased as real encyclopedia subjects — drives image search. */
  suggestedVisuals: string[];
  learningObjectives: string[];
}

// Content-addressed: keyed by the page text itself, not the document URL, so it
// survives re-uploads, works for locally-opened files (blob: URLs have no
// stable identity), and naturally varies with the page selection.
// Bump whenever the shape of DocumentContext changes OR the prompt that
// produces it changes meaningfully — v3 is the latter: CONCRETE_QUERY_RULE
// rewrote how suggestedVisuals are phrased, and without a bump every already-
// scanned document kept serving the old descriptive sentences for a week. Without it a cached
// context written by an older build is returned as-is for a week, silently
// missing every field added since — which is how subject-aware image search
// shipped and then did nothing for any document that had already been scanned.
const CONTEXT_SCHEMA_VERSION = 3;

function contextCacheKey(pageText: string): string {
  const hash = crypto.createHash("sha256").update(pageText).digest("hex").slice(0, 32);
  return `blackboard:ctx:v${CONTEXT_SCHEMA_VERSION}:${hash}`;
}

const CONTEXT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // documents don't change

// Shared by both stages that produce image search terms.
//
// Written after a real failure: a chapter on hydroelectric power generation
// produced queries like "Energy conversion" and "Conversion of potential energy
// to electrical energy", which resolve to the generic "Energy transformation"
// article — so the lesson got abstract physics diagrams instead of dams,
// turbines and power stations. Models reach for the underlying principle when
// asked what a lesson is "about"; image search needs the concrete thing.
const CONCRETE_QUERY_RULE =
  'Each must be a real, lookup-able encyclopedia subject — the NAME OF A CONCRETE THING, not the abstract principle behind it. ' +
  'Name the object, place, organism, device, structure or named event the material is actually about. ' +
  'For a lesson on hydroelectric power that would be "Hydroelectric power station", "Water turbine", "Dam", "Penstock" — NEVER "Energy conversion", "Energy transformation" or "Conversion of potential energy to electrical energy", which return generic diagrams belonging to no particular lesson. ' +
  'Avoid queries whose words are all general-purpose ("energy", "power", "system", "process", "types", "structure", "method") — such a query cannot identify a specific subject and will return unrelated images. ' +
  'Prefer the most specific term the material itself uses. ' +
  'Never use a descriptive phrase or a sentence, and never an acronym: write "Distributed file system", not "DFS".';

const CONTEXT_SYSTEM_PROMPT =
  "You are analyzing classroom teaching material. You will be given the combined text of one or more selected pages from a document — treat it as a single unified context, not as separate pages. " +
  "Read it fully, then produce a structured understanding of what it teaches. Do not summarize for a reader; extract structure. " +
  "Respond only in English, regardless of the language of the source material. " +
  'Return ONLY valid JSON, no markdown, with exactly these keys: ' +
  '"topic" (short string — the real subject, never a page number or file name), ' +
  '"subtopics" (array of 3-6 strings), ' +
  '"keywords" (array of 5-12 important terms, scientific names, or symbols appearing in the material), ' +
  '"definitions" (array of up to 5 objects {"term","meaning"} for terms the material actually defines), ' +
  '"conceptType" (short label such as "Biological Process", "Algorithm", "Historical Event", "Mathematical Theorem"), ' +
  `"subject" (the school subject this material belongs to, chosen from EXACTLY this list: ${MINDMAP_SUBJECTS.join(", ")}. Use "general" only if none of the others fit), ` +
  `"suggestedVisuals" (array of 3-6 concrete, picturable subjects — imagine you are the teacher standing in front of the class deciding what to put on the board. Prefer: labelled diagrams that show structure, processes or cycles that show change over time and work well as an animation, and real-world examples students can connect to their own experience. Favour a visual that makes a student ask "why does that happen?" over a merely decorative one. ${CONCRETE_QUERY_RULE}), ` +
  '"learningObjectives" (array of 2-4 strings describing what a student should be able to do after this material).';

async function buildDocumentContext(
  pageText: string,
  institutionId: string,
  teacherId: string,
  userId: string
): Promise<DocumentContext | null> {
  if (!openai) return null;

  const cacheKey = contextCacheKey(pageText);
  const cached = await getCache<DocumentContext>(cacheKey);
  // Belt-and-braces alongside the version bump: an entry missing `subject`
  // predates subject-aware retrieval, and using it would quietly downgrade
  // this scan to the generic strategy.
  if (cached && cached.subject) return cached;

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: CONTEXT_SYSTEM_PROMPT },
        { role: "user", content: `Combined content from the selected page(s):\n${pageText}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 900,
      // gpt-oss models on Groq spend hidden "reasoning" tokens before the
      // JSON answer; low effort keeps that overhead small and predictable
      // for a plain extraction task like this. No-op on OpenAI's gpt-4.1-mini.
      ...(AI_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
    });
  } catch (err) {
    await recordAiUsage({
      institutionId, teacherId, userId, userRole: "TEACHER",
      feature: "BLACKBOARD_CONTEXT" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
      requestType: "chat_completion", status: "FAILED", error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await recordAiUsage({
    institutionId, teacherId, userId, userRole: "TEACHER",
    feature: "BLACKBOARD_CONTEXT" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
    requestType: "chat_completion", status: "SUCCESS",
    inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
    totalTokens: completion.usage?.total_tokens,
  });

  let parsed: Partial<DocumentContext>;
  try {
    parsed = JSON.parse(completion.choices[0].message.content ?? "{}");
  } catch {
    // A malformed context shouldn't fail the whole scan — the caller falls
    // back to generating directly from the raw page text.
    console.error("[blackboard] Context extraction returned malformed JSON");
    return null;
  }

  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

  const context: DocumentContext = {
    topic: typeof parsed.topic === "string" ? parsed.topic : "",
    subtopics: asStrings(parsed.subtopics),
    keywords: asStrings(parsed.keywords),
    definitions: Array.isArray(parsed.definitions)
      ? parsed.definitions.filter(
          (d): d is { term: string; meaning: string } =>
            !!d && typeof d === "object" && typeof (d as { term?: unknown }).term === "string" &&
            typeof (d as { meaning?: unknown }).meaning === "string"
        ).slice(0, 5)
      : [],
    conceptType: typeof parsed.conceptType === "string" ? parsed.conceptType : "",
    subject: normalizeSubject(parsed.subject),
    suggestedVisuals: asStrings(parsed.suggestedVisuals),
    learningObjectives: asStrings(parsed.learningObjectives),
  };

  if (!context.topic) return null;

  await setCache(cacheKey, context, CONTEXT_CACHE_TTL_SECONDS);
  return context;
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

// The model is asked for a specific JSON shape but isn't bound to it — it
// will happily return detailedNotes as an array of paragraphs, or
// keyPoints as a newline-joined string. Normalize here so the API contract
// actually holds and clients can render the response without type-guarding
// every field (an array reaching a `.split()` call is a hard crash).
const asText = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (Array.isArray(v)) {
    const parts = v
      .map(item => {
        if (typeof item === "string") return item;
        // Sectioned notes sometimes arrive as [{ heading, body }, ...].
        if (item && typeof item === "object") {
          return Object.values(item).filter((s): s is string => typeof s === "string").join("\n");
        }
        return "";
      })
      .map(s => s.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return undefined;
};

/**
 * Best-effort recovery of a JSON object that was cut off at the token ceiling.
 *
 * Long documents in notes mode could exceed the output budget, and a truncated
 * response is invalid JSON — so the teacher got "select fewer pages" and lost
 * everything the model had already written. Closing the dangling string and
 * brackets recovers the completed fields (topic, overview, keyPoints, and any
 * finished note sections), which is far more useful than an error.
 */
function repairTruncatedJson(raw: string): Record<string, unknown> | null {
  let text = raw.trimEnd();
  // Drop a trailing partial token ("detailedNo) that can't be closed usefully.
  text = text.replace(/,\s*"[^"]*$/, "").replace(/,\s*$/, "");

  // Walk the text tracking string state so brackets inside strings are ignored.
  let inString = false, escaped = false;
  const stack: string[] = [];
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) text += '"';
  // A value may be mid-write ("key": ) — trim back to the last complete entry.
  text = text.replace(/,?\s*"[^"]*"\s*:\s*$/, "");
  while (stack.length > 0) text += stack.pop() === "{" ? "}" : "]";

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Sectioned study notes, as produced by `noteSections`. */
interface NoteSection { heading: string; body: string }

const asSections = (v: unknown): NoteSection[] => {
  if (!Array.isArray(v)) return [];
  return v
    .map(item => {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      const heading = typeof o.heading === "string" ? o.heading.trim() : "";
      const body = typeof o.body === "string" ? o.body.trim() : asText(o.body) ?? "";
      return heading || body ? { heading, body } : null;
    })
    .filter((x): x is NoteSection => x !== null);
};

const asBullets = (v: unknown): string[] => {
  if (Array.isArray(v)) {
    return v
      .map(item => (typeof item === "string" ? item : asText(item) ?? ""))
      .map(s => s.trim())
      .filter(Boolean);
  }
  const text = asText(v);
  return text ? text.split(/\n+/).map(s => s.trim()).filter(Boolean) : [];
};

// ── Duplicate-submit guard ────────────────────────────────────────────────────
//
// NOT a result cache. Caching Stage 3's output would make every repeat scan
// return the identical answer, which is exactly what the refinement chain below
// exists to prevent — the two are mutually exclusive.
//
// What this stops is accidental spend: a double-click, a resubmit, a component
// remount, a flaky connection retried. Those arrive within seconds of each
// other; a teacher deliberately asking for a better result does not. The window
// is therefore deliberately short — long enough to catch a duplicate, far too
// short to interfere with an intentional re-scan.
const DUPLICATE_SCAN_WINDOW_SECONDS = 90;

function duplicateScanKey(
  teacherId: string,
  pageText: string | undefined,
  topic: string,
  instructions: string | undefined,
  mode: string,
): string {
  const basis = pageText?.trim() ? pageText : topic;
  const hash = crypto
    .createHash("sha256")
    .update(`${teacherId}::${mode}::${instructions ?? ""}::${basis}`)
    .digest("hex")
    .slice(0, 32);
  return `blackboard:scandup:v1:${hash}`;
}

// ── Iterative refinement across repeated scans ────────────────────────────────
//
// A teacher who scans the same pages a second time is not asking for the same
// answer again — they are asking for a better one. Without memory of what it
// produced last time the model cannot improve on it: stage 1 is cached, images
// are cached, and only sampling noise separated one run from the next.
//
// Same mechanism the quiz already uses for question history (see
// quizHistoryKey): content-addressed Redis, capped and TTL'd. Keyed by teacher
// + page text + mode, deliberately NOT by instructions — a teacher steering the
// next pass ("now focus on the diagrams") is refining, not starting over.
const SCAN_HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60;
const SCAN_HISTORY_MAX_CAPTIONS = 24;

interface ScanHistoryEntry {
  /** Number of results produced for this material so far. */
  attempt: number;
  topic: string;
  overview: string;
  keyPoints: string[];
  detailedNotes?: string;
  /** Captions of the images last shown, so the next pass can better them. */
  imageCaptions: string[];
}

function scanHistoryKey(teacherId: string, pageText: string | undefined, topic: string, mode: string): string {
  const basis = pageText?.trim() ? pageText : topic;
  const hash = crypto.createHash("sha256").update(`${teacherId}::${mode}::${basis}`).digest("hex").slice(0, 32);
  return `blackboard:scanhist:v1:${hash}`;
}

/**
 * The refinement brief. The anti-churn clause is the important half: told only
 * to "improve", a model reliably rewrites correct sentences into different
 * correct sentences, which reads as change without being improvement. Naming
 * that failure explicitly, and directing effort at depth once breadth is
 * covered, is what makes a second pass worth its tokens.
 */
function buildRefinementBlock(previous: ScanHistoryEntry, mode: string): string {
  const previousOutput = [
    `Topic: ${previous.topic}`,
    previous.overview ? `Overview: ${previous.overview}` : "",
    previous.keyPoints.length ? `Key points:\n${previous.keyPoints.map(k => `- ${k}`).join("\n")}` : "",
    mode === "notes" && previous.detailedNotes ? `Detailed notes:\n${previous.detailedNotes}` : "",
    previous.imageCaptions.length ? `Images shown:\n${previous.imageCaptions.map(c => `- ${c}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  return (
    `\nYOUR PREVIOUS ANSWER FOR THIS EXACT MATERIAL (refinement pass ${previous.attempt + 1}):\n"""\n${previousOutput}\n"""\n\n` +
    `The teacher has scanned this material again, which means they want a BETTER answer than the one above — not the same one, and not a reworded one.\n` +
    `Re-read the source material and improve on it by:\n` +
    `- covering important points in the material that the previous answer missed or treated too briefly;\n` +
    `- correcting anything the previous answer got wrong or stated imprecisely;\n` +
    `- explaining the harder ideas more clearly for students;\n` +
    `- removing repetition, filler and anything that does not help teach this material.\n` +
    `CRITICAL: do NOT reword something merely to make it look different — a reworded correct sentence is worse than repeating it. ` +
    `Whatever the previous answer got right should be KEPT and strengthened. ` +
    `If it already covered the material broadly, add depth instead of breadth: worked detail, causes and consequences, common student misconceptions, or connections the material actually supports. ` +
    `Every addition must still come from the source material.\n`
  );
}

export const aiScan = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const data = aiScanSchema.parse(req.body);

    if (!openai) {
      return res.json({ success: true, data: MOCK_SCAN });
    }

    const teacherId = await getTeacherId(userId, institutionId);
    await checkTokenPool(institutionId, teacherId);

    // Previous result for this exact material, if the teacher has scanned it
    // before. Drives the refinement brief below and lets image selection better
    // what was shown last time.
    // Checked before any AI call, so a duplicate submit costs nothing at all.
    const dupKey = duplicateScanKey(
      teacherId, data.pageText, data.topic, data.instructions, data.mode
    );
    const duplicate = await getCache<Record<string, unknown>>(dupKey);
    if (duplicate) {
      console.log(`[blackboard] Identical scan within ${DUPLICATE_SCAN_WINDOW_SECONDS}s — returning previous result, no tokens spent`);
      res.json({ success: true, data: duplicate });
      return;
    }

    const historyKey = scanHistoryKey(teacherId, data.pageText, data.topic, data.mode);
    const previousScan = await getCache<ScanHistoryEntry>(historyKey);
    if (previousScan) {
      console.log(`[blackboard] Repeat scan of the same material — refinement pass ${previousScan.attempt + 1}`);
    }

    // ── Stage 1+2: understand the document, once ─────────────────────────────
    // Cached by content hash, so repeat scans of the same pages (different
    // instructions, switching summary/notes) skip this entirely.
    const context = data.pageText
      ? await buildDocumentContext(data.pageText, institutionId, teacherId, userId)
      : null;

    // ── Stage 3: interpret the instructions against that understanding ───────
    // Strict grounding. The previous rule ("you may draw on your own knowledge
    // to add helpful context") combined with a Stage 3 that never saw the
    // document meant the substance of every scan was generated from the model's
    // training data rather than read from the teacher's pages.
    const groundingRule =
      "Every fact, definition, number, date, name and example in your output MUST come from the source material given below. " +
      "Do NOT add information from your own knowledge, and do not generalise beyond what the material states. " +
      "If the material does not cover something the instructions ask for, say so briefly instead of inventing it. " +
      "Rephrasing, organising and simplifying the material for students is expected and encouraged — introducing new content is not.";
    const instructionRule = "The teacher's instructions are REQUIRED reading, not optional flavor text — if given, they must visibly shape what you emphasize, how you format the output, or what you focus on (e.g. \"focus on the diagrams\" or \"summarize for a 5th grader\"). Instructions guide the output; they are never the topic.";
    const languageRule = "Respond only in English, regardless of the language of the source material or the teacher's instructions.";

    // Sectioned rather than one prose block. A wall of paragraphs is hard to
    // study from, and Stage 1 has already identified the material's subtopics —
    // so the structure exists, it just wasn't being used.
    const notesField = data.mode === "notes"
      ? ', noteSections (array of 3-8 objects {"heading","body"} forming real study notes a student could learn from. ' +
        'Headings must follow the material\'s own structure — use its subtopics, in the order the material presents them — and be specific ("How chlorophyll traps light"), never generic ("Introduction", "Details", "Conclusion"). ' +
        'Each body is 1-3 short paragraphs covering definitions, how the thing works, and why it matters. Do not merely rephrase the key points)'
      : "";
    // imageQueries is what finally lets the teacher's instructions steer the
    // visuals. The document context is built without ever seeing instructions
    // (that's what makes it cacheable), so if image search ran off the context
    // alone — as it did before — writing "show me the female reproductive
    // system" changed the text but not a single image. This call does see the
    // instructions, so it's the right place to derive search subjects.
    const visualSelectionRule =
      "Choose the visuals the way an experienced teacher would when deciding what to put on the board for a mixed-ability class: prefer labelled diagrams that show structure, processes or cycles that show change over time (these work well as animations), and real-world examples students can connect to their own lives. Favour visuals that spark a question over decorative ones. " +
      "If the teacher's instructions name a particular aspect, focus, or sub-topic, the visuals MUST reflect that — their instruction outranks the document's general topic when deciding what to picture.";
    const outputShape =
      `Return a JSON object with: topic (short string), overview (1-2 sentence summary), keyPoints (array of 4-6 concise bullet strings)${notesField}, ` +
      `imageQueries (array of 3-6 subjects to search for images of. ${visualSelectionRule} ${CONCRETE_QUERY_RULE}), ` +
      `imageCount (integer — ONLY include this key if the teacher's instructions explicitly ask for a specific number of images, e.g. "show me 3 diagrams"; otherwise omit it entirely so every available diagram is returned). ` +
      `Return ONLY valid JSON, no markdown.`;

    let systemPrompt: string;
    let userContent: string;

    // Emphasised and labelled binding rather than trailing as "(optional)" —
    // buried at the end of the message the model treated instructions as
    // background colour instead of a constraint on the output.
    const scanInstructionBlock = data.instructions
      ? `\nTEACHER'S INSTRUCTIONS — binding. They must visibly shape what you emphasise, how you word the output, and which visuals you choose:\n"${data.instructions}"\n`
      : "";

    const refinementBlock = previousScan ? buildRefinementBlock(previousScan, data.mode) : "";

    if (data.pageText) {
      // The verbatim pages are the source of truth. Previously this branch sent
      // ONLY the distilled context — a ~250-word skeleton (topic, a few
      // subtopics, keywords and definitions, capped at 900 tokens) standing in
      // for a whole chapter — so keyPoints and detailedNotes were a summary of
      // a summary, and the detail had to be invented. The structured analysis
      // is still included, but as orientation, explicitly subordinate to the text.
      systemPrompt =
        `You are a knowledgeable teacher's assistant. You will be given the verbatim text of the pages a teacher selected, ` +
        `a structured analysis of those same pages, and the teacher's instructions. ` +
        `${instructionRule} ${groundingRule} ${languageRule} ${outputShape}`;
      userContent =
        `SOURCE MATERIAL — the selected pages, verbatim. This is the only permitted source of facts:\n"""\n${data.pageText}\n"""\n` +
        (context
          ? `\nStructured analysis of that same material, for orientation only. Where it differs from the text above, the text wins:\n${JSON.stringify(context)}\n`
          : "") +
        scanInstructionBlock +
        refinementBlock;
    } else {
      // No page content (non-PDF/PPTX doc, extraction failed client-side, or
      // context extraction errored) — fall back to the previous behavior of
      // working from whatever label/instructions we have.
      systemPrompt = `You are a knowledgeable teacher's assistant. You'll be given a topic/document label and, optionally, the teacher's instructions. ${instructionRule} ${groundingRule} ${languageRule} ${outputShape}`;
      userContent = `Topic: ${data.topic}\n${scanInstructionBlock}${refinementBlock}`;
    }

    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        // Notes mode asks for a much longer detailedNotes field on top of the
        // usual fields, so it needs a bigger budget than a quick summary.
        max_tokens: data.mode === "notes" ? 4000 : 900,
        ...(AI_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
      });
    } catch (err) {
      await recordAiUsage({
        institutionId, teacherId, userId, userRole: "TEACHER",
        feature: "BLACKBOARD_SCAN" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
        requestType: "chat_completion", status: "FAILED", error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    await recordAiUsage({
      institutionId, teacherId, userId, userRole: "TEACHER",
      feature: "BLACKBOARD_SCAN" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
      requestType: "chat_completion", status: "SUCCESS",
      inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens,
    });

    // A response cut off at the token ceiling is truncated mid-JSON, so the
    // parse below fails and the teacher sees "malformed JSON — please retry",
    // which retries into the same ceiling. Nothing checked this before.
    const finishReason = completion.choices[0].finish_reason;
    if (finishReason === "length") {
      console.warn(
        `[blackboard] Scan response hit the token ceiling (mode=${data.mode}) — output truncated. ` +
        `Consider fewer pages or a shorter instruction.`
      );
    }

    const rawContent = completion.choices[0].message.content ?? "{}";
    let parsed: Record<string, unknown>;
    let salvaged = false;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      // Truncation is recoverable; genuinely malformed output is not.
      const repaired = finishReason === "length" ? repairTruncatedJson(rawContent) : null;
      if (!repaired) {
        throw new BadRequestError(
          finishReason === "length"
            ? "The answer was too long to finish — try selecting fewer pages."
            : "AI returned malformed JSON — please retry"
        );
      }
      parsed = repaired;
      salvaged = true;
      console.warn("[blackboard] Recovered a truncated scan response — some sections may be missing");
    }

    // Default to "as many diagrams as exist" rather than a fixed count — a
    // teacher wants the full set of usable schematics for a topic. An explicit
    // request in the instructions still wins, clamped to the ceiling.
    const requestedImageCount = typeof parsed.imageCount === "number" && Number.isFinite(parsed.imageCount)
      ? Math.min(Math.max(Math.round(parsed.imageCount), 1), MAX_IMAGES_PER_SCAN)
      : MAX_IMAGES_PER_SCAN;

    // ── Stage 4: retrieve images from the document's own concepts ────────────
    const derivedTopic = typeof parsed.topic === "string" && parsed.topic.trim() ? parsed.topic : undefined;

    // Instruction-aware queries lead; the document's own suggested visuals
    // follow as backup so a vague or empty instruction still yields images.
    const instructionQueries = Array.isArray(parsed.imageQueries)
      ? parsed.imageQueries
          .map(q => (typeof q === "string" ? q.trim() : ""))
          .filter(Boolean)
          .slice(0, 6)
      : [];

    const baseContext: DocumentContext = context ?? {
      topic: derivedTopic ?? "",
      subtopics: [], keywords: [], definitions: [],
      conceptType: "", subject: "general", suggestedVisuals: [], learningObjectives: [],
    };
    const searchContext: DocumentContext = {
      ...baseContext,
      suggestedVisuals: [...instructionQueries, ...baseContext.suggestedVisuals],
    };
    if (instructionQueries.length > 0) {
      console.log(`[blackboard] Instruction-derived image queries: ${JSON.stringify(instructionQueries)}`);
    }
    // Relevance is judged against what the scan ITSELF just produced — the
    // overview and key points are the most faithful statement of what these
    // pages teach that exists at this point in the request, far better than the
    // topic string or the cached context skeleton.
    const lessonSummary = [
      typeof parsed.topic === "string" ? parsed.topic : "",
      asText(parsed.overview) ?? "",
      ...asBullets(parsed.keyPoints),
    ].filter(Boolean).join("\n").slice(0, 1500);

    const images = await retrieveConceptImages(searchContext, {
      limit: requestedImageCount,
      rawText: data.pageText,
      instructions: data.instructions,
      lessonSummary,
      usage: { institutionId, teacherId, userId },
      previousImageCaptions: previousScan?.imageCaptions,
      refinementPass: previousScan ? previousScan.attempt : 0,
    });

    const finalTopic = (typeof parsed.topic === "string" && parsed.topic.trim()) || searchContext.topic || "";
    const finalOverview = asText(parsed.overview) ?? "";
    const finalKeyPoints = asBullets(parsed.keyPoints);
    const finalSections = asSections(parsed.noteSections);
    // `detailedNotes` stays in the response as the flattened form so anything
    // already consuming it keeps working; noteSections is the structured view.
    // A model that ignored the new shape and returned prose still lands here.
    const finalNotes = finalSections.length > 0
      ? finalSections.map(sec => (sec.heading ? `${sec.heading}\n${sec.body}` : sec.body)).join("\n\n")
      : asText(parsed.detailedNotes);

    // Recorded so the NEXT scan of this material improves on this one rather
    // than regenerating from zero. setCache is already best-effort (it no-ops
    // when Redis is down and swallows write errors), so a Redis outage costs
    // the refinement chain, never the scan the teacher just paid tokens for.
    const historyEntry: ScanHistoryEntry = {
      attempt: (previousScan?.attempt ?? 0) + 1,
      topic: finalTopic,
      overview: finalOverview,
      keyPoints: finalKeyPoints,
      ...(finalNotes ? { detailedNotes: finalNotes } : {}),
      imageCaptions: images.map(i => i.caption).slice(0, SCAN_HISTORY_MAX_CAPTIONS),
    };
    await setCache(historyKey, historyEntry, SCAN_HISTORY_TTL_SECONDS);

    const responseData = {
      topic: finalTopic,
      overview: finalOverview,
      keyPoints: finalKeyPoints,
      ...(finalNotes ? { detailedNotes: finalNotes } : {}),
      ...(finalSections.length > 0 ? { noteSections: finalSections } : {}),
      // Lets the client say so plainly rather than silently showing a
      // half-finished set of notes as if it were complete.
      ...(salvaged ? { truncated: true } : {}),
      images,
      // Surfaced so the client can show what the AI actually understood, and
      // so a future "regenerate with different instructions" flow can reuse
      // it without re-deriving.
      context,
    };

    // Short window only — see duplicateScanKey.
    await setCache(dupKey, responseData, DUPLICATE_SCAN_WINDOW_SECONDS);

    res.json({ success: true, data: responseData });
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

    const teacherId = await getTeacherId(userId, institutionId);
    await checkTokenPool(institutionId, teacherId);

    // Ground the conversation in the pages actually open on the board. Reuses
    // aiScan's cached context, so this is free when those pages were already
    // scanned.
    const docContext = data.pageText
      ? await buildDocumentContext(data.pageText, institutionId, teacherId, userId)
      : null;

    // The assistant must not police scope. A teacher asking about surrogacy
    // while teaching human reproduction is exploring the subject, not going
    // off-topic — refusing or deflecting there is a failure, not caution.
    // Lesson context exists to make answers *better targeted*, never to
    // narrow what may be asked.
    const scopeRule =
      "The lesson context tells you who you're helping and at what level — use it to pitch your answer appropriately. It is NOT a restriction on what may be discussed. " +
      "Answer every question the teacher asks, including ones that extend beyond the exact page content: related concepts, wider applications, ethical or social dimensions, and background the pages assume. " +
      "Never tell the teacher a question is off-topic, never deflect, and never suggest returning to the lesson — they decide what's relevant to their own class. " +
      "Where a natural connection to the material exists, draw it; where none exists, simply answer the question well. " +
      "These are professional educators discussing curriculum subjects: handle sensitive topics such as reproduction, health, or social issues factually and matter-of-factly, at a level appropriate for the classroom. " +
      "Format replies in simple markdown so they're easy to scan: short paragraphs, **bold** for key terms, and numbered or bulleted lists when enumerating parts, steps, or examples. " +
      "Skip headings and tables — the chat panel is narrow. Lead with the answer rather than restating the question. " +
      // Emojis are a scanning aid here, not decoration: one anchoring a list
      // item gives the eye something to land on when a teacher is glancing at
      // the panel mid-lesson. Capped deliberately — a teacher tool that reads
      // as gimmicky loses credibility faster than a plain one.
      "Use a few well-chosen emojis to make replies warm and easy to scan — typically one opening the reply and one per list item, matched to the subject (🌱 plants, 🧬 genetics, ⚡ energy, 🔬 experiments, 🌍 geography, 📐 maths, 💡 key insight, ⚠️ common mistake). " +
      "Keep them purposeful and sparing: never more than one per line, never inside the middle of a sentence, and none at all where they would trivialise a serious topic such as health, reproduction, or social issues. " +
      "Write in a warm, encouraging, conversational voice — you are talking to a fellow teacher, not writing a textbook entry. " +
      "Respond only in English, regardless of the language of the lesson material.";

    let systemContent: string;
    if (docContext) {
      // Include the page text verbatim alongside the distilled context: the
      // structured summary is good for "what is this lesson about", but
      // questions like "who are the people mentioned here" need the actual
      // words on the page.
      systemContent =
        `You are a classroom teaching assistant helping a teacher. Below is the material currently open on their board — this IS the page content, so never ask the teacher to provide it, and never say it wasn't supplied.\n\n` +
        `Topic: ${docContext.topic}\n` +
        (docContext.subtopics.length ? `Subtopics: ${docContext.subtopics.join(", ")}\n` : "") +
        (docContext.keywords.length ? `Key terms: ${docContext.keywords.join(", ")}\n` : "") +
        `\nPage content:\n"""\n${(data.pageText ?? "").slice(0, 6000)}\n"""\n\n` +
        `${scopeRule} Keep answers concise and clear.`;
    } else if (data.context) {
      // Only a filename is known — say so plainly rather than pretending to
      // see content, but still answer the question on general knowledge.
      systemContent =
        `You are a classroom teaching assistant helping a teacher. They are working from a document named "${data.context}", but its contents are not available to you. ` +
        `Answer from your own knowledge of the subject; do not claim to see the page, and do not refuse simply because the page text is missing. ${scopeRule} Keep answers concise and clear.`;
    } else {
      systemContent = `You are a classroom teaching assistant. Answer clearly and concisely, with educational accuracy. ${scopeRule}`;
    }

    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: "system", content: systemContent },
          ...data.messages,
        ],
        max_tokens: 500,
        ...(AI_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
      });
    } catch (err) {
      await recordAiUsage({
        institutionId, teacherId, userId, userRole: "TEACHER",
        feature: "BLACKBOARD_CHAT" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
        requestType: "chat_completion", status: "FAILED", error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    await recordAiUsage({
      institutionId, teacherId, userId, userRole: "TEACHER",
      feature: "BLACKBOARD_CHAT" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
      requestType: "chat_completion", status: "SUCCESS",
      inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens,
    });

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

// Quiz generation is stateless, so every run sees the same material and
// gravitates to the same "obvious" questions — which is why easy/medium/hard
// on one page kept producing overlapping sets. Remembering what's already been
// asked for a given page and telling the model to avoid it is the only thing
// that reliably breaks that: a variation token nudges sampling, it doesn't
// stop the model rediscovering the same facts.
const QUIZ_HISTORY_TTL_SECONDS = 24 * 60 * 60;
const QUIZ_HISTORY_MAX = 40;

function quizHistoryKey(pageText: string | undefined, topic: string): string {
  // Keyed by content, deliberately NOT by difficulty — the point is that
  // switching easy → hard on the same page yields different questions too.
  const basis = pageText?.trim() ? pageText : topic;
  return `blackboard:quizasked:${crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32)}`;
}

async function getAskedQuestions(key: string): Promise<string[]> {
  return (await getCache<string[]>(key)) ?? [];
}

async function recordAskedQuestions(key: string, previous: string[], added: string[]): Promise<void> {
  // Newest first, capped — an unbounded list would eventually crowd the prompt
  // and start costing more than the repetition it prevents.
  const merged = [...added, ...previous].slice(0, QUIZ_HISTORY_MAX);
  await setCache(key, merged, QUIZ_HISTORY_TTL_SECONDS);
}

export const aiQuiz = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const data = aiQuizSchema.parse(req.body);

    if (!openai) {
      return res.json({ success: true, data: { questions: MOCK_QUIZ.slice(0, data.count) } });
    }

    const teacherId = await getTeacherId(userId, institutionId);
    await checkTokenPool(institutionId, teacherId);

    // Same cached extraction aiScan uses — free when these pages were already
    // scanned, and gives the generator a real understanding of the material
    // rather than only the raw text.
    const quizContext = data.pageText
      ? await buildDocumentContext(data.pageText, institutionId, teacherId, userId)
      : null;

    // "at hard difficulty" on its own is a label the model applies weakly and
    // inconsistently. Spelling out the cognitive demand AND how distractors
    // should behave is what actually separates the three levels — at easy the
    // wrong options are obviously wrong, at hard they're real misconceptions.
    const DIFFICULTY_GUIDANCE: Record<"easy" | "medium" | "hard", string> = {
      easy:
        "EASY means direct recall: each answer is a fact stated plainly in the material, and a student who simply read the pages can answer it. " +
        "Wrong options should be clearly and obviously wrong to anyone who read the material.",
      medium:
        "MEDIUM means understanding and application: the student must connect two facts, apply a definition to a fresh example, or explain why something happens rather than just name it. " +
        "Wrong options should be plausible on a quick read but clearly distinguishable to a student who understood the material.",
      hard:
        "HARD means analysis and inference: the student must compare concepts, reason about consequences, spot an exception, or work out something the material implies without stating outright. " +
        "Wrong options must be genuine misconceptions a real student would hold — never filler. A student who merely memorised the text should find these difficult.",
    };

    // Nothing else in this prompt changes between runs on the same pages, so
    // without a varying token the model converges on near-identical question
    // sets — a teacher regenerating gets the same quiz back.
    const variationSeed = crypto.randomBytes(4).toString("hex");

    const systemPrompt =
      `You are a quiz generator for classroom teachers. Generate exactly ${data.count} multiple-choice questions. ` +
      `${DIFFICULTY_GUIDANCE[data.difficulty]} ` +
      `Variation token ${variationSeed}: produce a genuinely different set from any previous one for this material — vary which facts and sections you test, vary the phrasing, and vary which option position holds the correct answer (do not favour any one position). ` +
      (data.pageText
        // Without this the model drifts to its own general knowledge of the
        // subject, producing questions that are "about the topic" but test
        // things the students were never taught from these pages.
        ? `Every question MUST be answerable purely from the supplied material — test what these specific pages actually teach, not general knowledge about the subject. Do not introduce facts, terms, or examples that do not appear in the material. `
        : "") +
      `Return a JSON object with a "questions" array. Each question: ` +
      `{ "id": "q1", "question": "...", "options": ["A", "B", "C", "D"], "answer": <0-indexed correct option number>, ` +
      `"explanation": "1-2 sentences stating why the correct option is right${data.pageText ? ", grounded in what the material actually says" : ""}, and briefly why the tempting wrong option is wrong" }. ` +
      `Respond only in English, regardless of the language of the source material. ` +
      `Return ONLY valid JSON, no markdown.`;

    const historyKey = quizHistoryKey(data.pageText, data.topic);
    const askedBefore = await getAskedQuestions(historyKey);
    const avoidBlock = askedBefore.length > 0
      ? `\nALREADY ASKED — do not repeat or reword any of these, and avoid testing the same specific fact they test. Pick different facts, different sections, and different angles:\n` +
        askedBefore.map(q => `- ${q}`).join("\n") + "\n"
      : "";

    // Instructions get their own emphasised line rather than a trailing
    // "(optional)" note — buried at the end they were being treated as
    // background rather than a constraint on what to ask.
    const instructionBlock = data.instructions
      ? `\nTEACHER'S INSTRUCTIONS — these are binding, and must shape which parts of the material you test and how you word the questions:\n"${data.instructions}"\n`
      : "";

    const userContent = data.pageText
      ? [
          quizContext ? `Document analysis:\n${JSON.stringify(quizContext)}\n` : "",
          `Material to base the questions on:\n${data.pageText}`,
          instructionBlock,
          avoidBlock,
        ].filter(Boolean).join("\n")
      : [`Topic: ${data.topic}`, instructionBlock, avoidBlock].filter(Boolean).join("\n");

    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        // Quizzes are the one place here where we actively want sampling
        // variance — a teacher regenerating expects a different paper, not the
        // same one reworded. Set explicitly rather than relying on the
        // provider default, which differs between OpenAI and Groq.
        temperature: 1,
        // Each question now carries an explanation on top of its options, so the
        // budget scales with question count rather than sitting at a flat cap
        // that would truncate the JSON mid-array for larger quizzes.
        max_tokens: Math.min(600 + data.count * 220, 3000),
        ...(AI_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
      });
    } catch (err) {
      await recordAiUsage({
        institutionId, teacherId, userId, userRole: "TEACHER",
        feature: "BLACKBOARD_QUIZ" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
        requestType: "chat_completion", status: "FAILED", error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    await recordAiUsage({
      institutionId, teacherId, userId, userRole: "TEACHER",
      feature: "BLACKBOARD_QUIZ" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
      requestType: "chat_completion", status: "SUCCESS",
      inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens,
    });

    let parsed: { questions?: unknown };
    try {
      parsed = JSON.parse(completion.choices[0].message.content ?? '{"questions":[]}');
    } catch {
      throw new BadRequestError("AI returned malformed JSON — please retry");
    }

    // As with aiScan, the model isn't bound to the requested JSON shape.
    // Quiz has more ways to go wrong than a summary does, and one of them
    // fails silently rather than loudly: if `answer` comes back as a letter
    // ("B") or as the answer text instead of an index, the client's
    // `selected === answer` check simply never matches, so every answer reads
    // as wrong. Normalize all three shapes to a real 0-based index here.
    const toOptions = (v: unknown): string[] => {
      if (Array.isArray(v)) {
        return v.map(o => (typeof o === "string" ? o : String(o ?? ""))).map(s => s.trim()).filter(Boolean);
      }
      // Sometimes returned as { "A": "...", "B": "..." } — preserve label order.
      if (v && typeof v === "object") {
        return Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, val]) => (typeof val === "string" ? val : String(val ?? "")).trim())
          .filter(Boolean);
      }
      return [];
    };

    const toAnswerIndex = (v: unknown, options: string[]): number | null => {
      if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < options.length) return v;
      if (typeof v === "string") {
        const trimmed = v.trim();
        // Numeric string — accept 0-based, and tolerate 1-based ("1".."4").
        if (/^\d+$/.test(trimmed)) {
          const n = parseInt(trimmed, 10);
          if (n >= 0 && n < options.length) return n;
          if (n >= 1 && n <= options.length) return n - 1;
        }
        // Single letter — "A"/"a" → 0, "B" → 1, ...
        if (/^[A-Za-z]$/.test(trimmed)) {
          const idx = trimmed.toUpperCase().charCodeAt(0) - 65;
          if (idx >= 0 && idx < options.length) return idx;
        }
        // The answer text itself rather than a position.
        const match = options.findIndex(o => o.toLowerCase() === trimmed.toLowerCase());
        if (match !== -1) return match;
      }
      return null;
    };

    const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions = rawQuestions
      .map((raw, i) => {
        if (!raw || typeof raw !== "object") return null;
        const q = raw as Record<string, unknown>;
        const question = typeof q.question === "string" ? q.question.trim() : "";
        const options = toOptions(q.options);
        // A question with no text or fewer than two choices isn't answerable —
        // drop it rather than rendering a broken card.
        if (!question || options.length < 2) return null;
        const answerIdx = toAnswerIndex(q.answer, options);
        if (answerIdx === null) return null;

        // Models cluster the correct answer at a favoured position no matter
        // how firmly the prompt asks otherwise — measured 6 of 9 at option C
        // on this model. A student could pass by always picking the same
        // letter. Shuffling here makes the distribution uniform by
        // construction rather than relying on the model to comply.
        const order = options.map((_, idx) => idx);
        for (let a = order.length - 1; a > 0; a--) {
          const b = crypto.randomInt(a + 1);
          [order[a], order[b]] = [order[b], order[a]];
        }
        const shuffledOptions = order.map(idx => options[idx]);
        const answer = order.indexOf(answerIdx);
        // Explanation is best-effort: a question is still usable without one,
        // so a missing or malformed value shouldn't discard the question.
        const explanation = typeof q.explanation === "string" && q.explanation.trim()
          ? q.explanation.trim()
          : undefined;
        return {
          id: typeof q.id === "string" && q.id.trim() ? q.id : `q${i + 1}`,
          question,
          options: shuffledOptions,
          answer,
          ...(explanation ? { explanation } : {}),
        };
      })
      .filter((q): q is { id: string; question: string; options: string[]; answer: number; explanation?: string } => q !== null);

    // The prompt asks the model to avoid the history, but compliance isn't
    // guaranteed — enforce it here so a repeat can't reach the teacher.
    // Normalised comparison so a reworded duplicate ("What is X?" vs "What
    // is X ?") is still caught.
    const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    const seenQuestions = new Set(askedBefore.map(normalise));
    const fresh = questions.filter(q => {
      const n = normalise(q.question);
      if (seenQuestions.has(n)) return false;
      seenQuestions.add(n);
      return true;
    });

    // Only fall back to the unfiltered set if dedup emptied it entirely —
    // better a repeated question than an empty quiz, but log it, since it
    // means the material is exhausted for this page.
    const finalQuestions = fresh.length > 0 ? fresh : questions;
    if (fresh.length < questions.length) {
      console.log(
        `[blackboard] Quiz: dropped ${questions.length - fresh.length} repeat(s) of previously asked questions` +
        `${fresh.length === 0 ? " — none left, returning originals (material may be exhausted)" : ""}`
      );
    }

    if (finalQuestions.length === 0) {
      throw new BadRequestError("AI returned no usable questions — please retry");
    }

    await recordAskedQuestions(historyKey, askedBefore, finalQuestions.map(q => q.question));

    res.json({ success: true, data: { questions: finalQuestions } });
  } catch (err) { next(err); }
};

// ── AI Mindmap ───────────────────────────────────────────────────────────────

interface MindmapNode {
  label: string;
  // One emoji the model picks per node. Rendering it is free and always
  // legible — unlike asking an image model to draw an icon, where the label
  // itself is at risk of coming back mangled.
  emoji?: string;
  // Root only — drives which paper/palette/handwriting the renderer uses.
  subject?: MindmapSubject;
  children: MindmapNode[];
}

const MAX_CHILDREN_PER_NODE = 8;
// Branches, then points beneath them. Fixed rather than teacher-selectable —
// see the note in aiMindmapSchema.
const MINDMAP_DEPTH = 2;

// A stray sentence in the emoji field would blow out the sticker layout, and
// emoji are multi-codepoint (👨‍👩‍👧 is 5), so cap by codepoint count rather
// than string length and drop anything that's clearly not an emoji.
function normalizeEmoji(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if ([...trimmed].length > 8) return undefined;
  // Reject plain text ("dna", "A") — a real emoji has no ASCII letters/digits.
  if (/[A-Za-z0-9]/.test(trimmed)) return undefined;
  return trimmed;
}

// Defends against a malformed or oversized LLM response before it's persisted
// or rendered — caps fan-out per node and recursion depth, drops anything
// without a usable label.
function normalizeMindmapNode(raw: unknown, depthLeft: number): MindmapNode | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  const label = typeof n.label === "string" ? n.label.trim() : "";
  if (!label) return null;
  const emoji = normalizeEmoji(n.emoji);
  const rawChildren = Array.isArray(n.children) ? n.children : [];
  const children = depthLeft > 0
    ? rawChildren
        .slice(0, MAX_CHILDREN_PER_NODE)
        .map((c) => normalizeMindmapNode(c, depthLeft - 1))
        .filter((c): c is MindmapNode => c !== null)
    : [];
  return { label, ...(emoji ? { emoji } : {}), children };
}

export const aiMindmap = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const data = aiMindmapSchema.parse(req.body);

    if (!openai) {
      const mock: MindmapNode = {
        label: data.topic,
        emoji: "🧠",
        subject: "general",
        children: [
          { label: "Key Concept 1", emoji: "💡", children: [{ label: "Detail A", children: [] }, { label: "Detail B", children: [] }] },
          { label: "Key Concept 2", emoji: "🔬", children: [{ label: "Detail C", children: [] }] },
          { label: "Key Concept 3", emoji: "🌱", children: [] },
        ],
      };
      return res.json({ success: true, data: { mindmap: mock, saved: false } });
    }

    const teacherId = await getTeacherId(userId, institutionId);
    await checkTokenPool(institutionId, teacherId);

    // Without a varying token the model converges on near-identical
    // breakdowns for the same topic/pages — a teacher regenerating expects a
    // genuinely different structure, not the same map reworded. Same fix as
    // AI Quiz's variationSeed.
    const variationSeed = crypto.randomBytes(4).toString("hex");

    const systemPrompt =
      `You are a mindmap generator for school students. Produce the clearest possible study map of the material — always exactly TWO levels below the root topic. ` +
      `Level 1: 4-6 main branches that together cover the whole topic without overlapping. ` +
      // Depth used to be a teacher-set option and depth 1 produced branches
      // with nothing under them. Every branch carrying points is what makes
      // the thing a mindmap rather than a list of headings.
      `Level 2: EVERY branch must have 2-4 short points under it. Never leave a branch empty. ` +
      // The map is rendered as fixed-width stickers, so a long label wraps to
      // three lines and wrecks the layout — this cap is a layout constraint,
      // not a style preference.
      `Every label must be SHORT: 2-5 words for a branch, at most 8 words for a point. Never write a full sentence. ` +
      `Each branch must break the topic into a distinct, non-overlapping idea — not a restatement of the parent. ` +
      `Give EVERY node an "emoji" field: a single emoji that visually represents that node (e.g. 🧬 for DNA, 🌱 for plants, 🦕 for evolution). ` +
      `Pick concrete, recognisable emoji a 15-year-old would connect to the idea. Never repeat the same emoji twice in one mindmap. ` +
      `Variation token ${variationSeed}: produce a genuinely different breakdown from any previous one for this material — vary which sub-ideas you pick, how you group them, and their ordering. ` +
      (data.pageText
        ? `Base the mindmap ONLY on the supplied material — do not introduce facts, terms, or examples that do not appear in it. `
        : "") +
      `Also return a top-level "subject" field naming the school subject this material belongs to, chosen from EXACTLY this list: ` +
      `${MINDMAP_SUBJECTS.join(", ")}. Use "general" only if none of the others fit. ` +
      `Return a JSON object: { "label": "<root topic>", "emoji": "<emoji>", "subject": "<subject>", "children": [ { "label": "...", "emoji": "...", "children": [ { "label": "...", "emoji": "...", "children": [] } ] }, ... ] }. ` +
      `Respond only in English, regardless of the language of the source material. Return ONLY valid JSON, no markdown.`;

    const instructionBlock = data.instructions
      ? `\nTEACHER'S INSTRUCTIONS — these are binding, and must shape which branches you include:\n"${data.instructions}"\n`
      : "";

    const userContent = data.pageText
      ? [`Material to base the mindmap on:\n${data.pageText}`, instructionBlock].filter(Boolean).join("\n")
      : [`Topic: ${data.topic}`, instructionBlock].filter(Boolean).join("\n");

    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        // Same reasoning as AI Quiz — regenerating should feel like a fresh
        // pass over the material, not a near-duplicate. 0.7 was converging
        // on the same structure most of the time.
        temperature: 1,
        // A mindmap is just short labels, not prose — the token budget is
        // small even at max depth/fan-out.
        max_tokens: 1200,
        ...(AI_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
      });
    } catch (err) {
      await recordAiUsage({
        institutionId, teacherId, userId, userRole: "TEACHER",
        feature: "BLACKBOARD_MINDMAP" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
        requestType: "chat_completion", status: "FAILED", error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    await recordAiUsage({
      institutionId, teacherId, userId, userRole: "TEACHER",
      feature: "BLACKBOARD_MINDMAP" as AiFeature, provider: AI_PROVIDER, model: AI_MODEL,
      requestType: "chat_completion", status: "SUCCESS",
      inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(completion.choices[0].message.content ?? "{}");
    } catch {
      throw new BadRequestError("AI returned malformed JSON — please retry");
    }

    const mindmap = normalizeMindmapNode(parsed, MINDMAP_DEPTH);
    if (!mindmap || mindmap.children.length === 0) {
      throw new BadRequestError("AI returned an unusable mindmap — please retry");
    }
    // A branch with no points renders as an empty box, which is what made the
    // old depth-1 maps look broken. Drop those rather than persist a map the
    // student will open once and never again.
    mindmap.children = mindmap.children.filter((b) => b.children.length > 0);
    if (mindmap.children.length < 2) {
      throw new BadRequestError("AI returned a mindmap with no detail — please retry");
    }
    // Only meaningful on the root; normalizeMindmapNode deliberately ignores
    // it on children so a stray value deeper in the tree can't change the look.
    mindmap.subject = normalizeSubject((parsed as Record<string, unknown>)?.subject);

    const saved = await academicDb().mindmap.create({
      data: {
        institutionId,
        teacherId,
        title: mindmap.label || data.topic,
        data: mindmap as unknown as object,
      },
    });

    res.json({ success: true, data: { mindmap, saved: true, id: saved.id } });
  } catch (err) { next(err); }
};

export const listMindmaps = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const mindmaps = await academicDb().mindmap.findMany({
      where: { institutionId, teacherId },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, createdAt: true },
    });
    res.json({ success: true, data: mindmaps });
  } catch (err) { next(err); }
};

export const getMindmap = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const mindmap = await academicDb().mindmap.findFirst({
      where: { id: req.params.id as string, institutionId, teacherId },
    });
    if (!mindmap) throw new NotFoundError("Mindmap not found");
    res.json({ success: true, data: mindmap });
  } catch (err) { next(err); }
};

export const deleteMindmap = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const mindmap = await academicDb().mindmap.findFirst({
      where: { id: req.params.id as string, institutionId, teacherId },
    });
    if (!mindmap) throw new NotFoundError("Mindmap not found");
    await academicDb().mindmap.delete({ where: { id: mindmap.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
};

export const searchImages = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = (req.query.q as string ?? "").trim();
    if (!q || q.length < 2) throw new BadRequestError("Query must be at least 2 characters");

    // The AI-driven scan path decides this from the document's own subject,
    // but a teacher typing here was previously getting photographs of
    // anything they searched for, gated only by the filename check. Apply the
    // same diagrams-only rule to a sensitive query typed by hand.
    // Both tiers apply here: this is a short query a teacher typed, not a whole
    // chapter of prose, so the clinical terms carry their literal meaning and
    // the false-positive risk that split them apart doesn't exist.
    const illustrationsOnly =
      SENSITIVE_EXPLICIT_PATTERN.test(q) ||
      SENSITIVE_BIOLOGICAL_PATTERN.test(q) ||
      SENSITIVE_CLINICAL_PATTERN.test(q);
    const images = await fetchWikimediaImages(q, 4, undefined, illustrationsOnly);
    res.json({ success: true, data: images });
  } catch (err) { next(err); }
};

