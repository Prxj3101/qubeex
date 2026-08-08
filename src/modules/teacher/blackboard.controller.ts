import crypto from "crypto";
import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { uploadAttachmentToR2, scheduleR2FileDeletion, r2KeyFromUrl } from "../../services/storage.service";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { createFolderSchema, aiScanSchema, aiChatSchema, aiQuizSchema } from "./blackboard.schema";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");
import { redis, isRedisReady } from "../../utils/redis";
import { getCache, setCache } from "../../utils/cache";
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
const SENSITIVE_SUBJECT_PATTERN =
  /\b(reproduct\w*|genital\w*|penis|penile|vulva|vagin\w*|testis|testes|testicl\w*|scrotum|uterus|uterine|ovar\w*|cervix|cervical|breast\w*|mammary|sperm\w*|semen|menstrua\w*|puberty|sexual\w*|intercourse|pregnan\w*|fetus|foetus|embryo\w*|anatomy|nude|naked)\b/i;

// SVG is a vector format — a photograph cannot be one — so it's a reliable
// "this is a drawn diagram" signal. Beyond that, recognise well-established
// illustration markers: scheme/diagram naming, the Blausen medical
// illustration library, and Gray's/Sobotta anatomy plates (19th-c. engravings).
const ILLUSTRATION_HINT =
  /(diagram|illustration|schematic|scheme|illu[_ ]|blausen|gray\d{3,4}|sobo[_ ]|labell?ed|cross[_ -]?section|drawing|sketch|chart)/i;

// Applied to EVERY image, regardless of whether the topic was flagged
// sensitive. Topic detection gates on the AI's word choices, so a single
// unanticipated phrasing would let a photograph through — this is the
// backstop that doesn't depend on that inference being right. A file named
// for explicit anatomy is only ever allowed through if it is also clearly a
// drawn diagram (e.g. "Vaginal_opening_description-en.svg", a labelled
// biology illustration, passes; "Front_and_back_womans_genitalia.jpg" does not).
const EXPLICIT_ANATOMY_FILENAME_PATTERN =
  /(genital\w*|penis|penile|vulva|vagina|scrotum|testicle\w*|breast\w*|nipple\w*|nude|naked|erect\w*|flaccid|labia|clitoris|anus|anal|buttock\w*|pubic|topless|semen|ejaculat\w*|masturbat\w*|coitus|copulat\w*)/i;

/** Final gate every image passes through before it can be returned to a classroom. */
function isClassroomSafe(title: string, url: string): boolean {
  const haystack = `${title} ${url}`;
  if (!EXPLICIT_ANATOMY_FILENAME_PATTERN.test(haystack)) return true;
  return isIllustration(title, url);
}

function isSensitiveSubject(context: DocumentContext): boolean {
  const haystack = [
    context.topic,
    context.conceptType,
    ...context.subtopics,
    ...context.keywords,
    ...context.suggestedVisuals,
  ].join(" ");
  return SENSITIVE_SUBJECT_PATTERN.test(haystack);
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
  return ILLUSTRATION_HINT.test(haystack);
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
  exclude: Set<string>,
  illustrationsOnly = false
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

async function fetchTopicImages(
  topics: string[],
  limit = 5,
  seenUrls: Set<string> = new Set(),
  illustrationsOnly = false
): Promise<{ url: string; caption: string }[]> {
  const results: { url: string; caption: string }[] = [];
  for (const topic of topics) {
    if (results.length >= limit) break;

    // Resolve the article even when its lead image is rejected by the
    // illustration filter — the article body often still holds usable
    // diagrams, which is exactly the case for anatomy topics.
    let hit = await fetchWikipediaSummary(topic, illustrationsOnly);
    let resolvedTitle = hit?.caption ?? topic;
    if (!hit) {
      const alt = await resolveWikipediaTitle(topic);
      if (alt && alt.toLowerCase() !== topic.toLowerCase()) {
        hit = await fetchWikipediaSummary(alt, illustrationsOnly);
        resolvedTitle = hit?.caption ?? alt;
      } else if (alt) {
        resolvedTitle = alt;
      }
    }

    if (hit && !seenUrls.has(hit.url)) {
      seenUrls.add(hit.url);
      results.push(hit);
    }
    if (results.length >= limit) break;

    const more = await fetchArticleEmbeddedImages(
      resolvedTitle,
      limit - results.length,
      seenUrls,
      illustrationsOnly
    );
    results.push(...more);
  }
  return results;
}

// ── Google Programmable Search (optional, paid) ───────────────────────────────
//
// Wikipedia is precise but has real coverage gaps: well-documented topics
// ("Chloroplast") have plenty of curated diagrams, while niche technical ones
// often have none at all. Google CSE fills those gaps by reaching the wider
// educational web. Enabled only when both env vars are set, so the whole
// feature degrades cleanly to Wikipedia-only when unconfigured.
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
async function retrieveConceptImages(
  context: DocumentContext,
  limit: number
): Promise<{ url: string; caption: string }[]> {
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
  const illustrationsOnly = isSensitiveSubject(context);
  console.log(
    `[blackboard] Image retrieval — topic="${context.topic}" sensitive=${illustrationsOnly} queries=${JSON.stringify(queries.slice(0, 6))}`
  );

  const seenUrls = new Set<string>();
  const results = await fetchTopicImages(queries, limit, seenUrls, illustrationsOnly);
  if (results.length >= limit) return results.slice(0, limit);

  for (const query of queries) {
    if (results.length >= limit) break;
    // "diagram" biases toward instructional illustrations over incidental
    // photos — the useful shape for classroom material.
    const fromGoogle = await fetchGoogleImages(
      `${query} diagram`,
      limit - results.length,
      seenUrls,
      illustrationsOnly
    );
    results.push(...fromGoogle);
  }

  return results.slice(0, limit);
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
  /** Concrete things worth picturing, phrased as real encyclopedia subjects — drives image search. */
  suggestedVisuals: string[];
  learningObjectives: string[];
}

// Content-addressed: keyed by the page text itself, not the document URL, so it
// survives re-uploads, works for locally-opened files (blob: URLs have no
// stable identity), and naturally varies with the page selection.
function contextCacheKey(pageText: string): string {
  return `blackboard:ctx:${crypto.createHash("sha256").update(pageText).digest("hex").slice(0, 32)}`;
}

const CONTEXT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // documents don't change

const CONTEXT_SYSTEM_PROMPT =
  "You are analyzing classroom teaching material. You will be given the combined text of one or more selected pages from a document — treat it as a single unified context, not as separate pages. " +
  "Read it fully, then produce a structured understanding of what it teaches. Do not summarize for a reader; extract structure. " +
  'Return ONLY valid JSON, no markdown, with exactly these keys: ' +
  '"topic" (short string — the real subject, never a page number or file name), ' +
  '"subtopics" (array of 3-6 strings), ' +
  '"keywords" (array of 5-12 important terms, scientific names, or symbols appearing in the material), ' +
  '"definitions" (array of up to 5 objects {"term","meaning"} for terms the material actually defines), ' +
  '"conceptType" (short label such as "Biological Process", "Algorithm", "Historical Event", "Mathematical Theorem"), ' +
  '"suggestedVisuals" (array of 3-6 concrete, picturable subjects that would genuinely help teach this — each phrased as a real encyclopedia subject someone could look up, e.g. "Chloroplast", "Calvin cycle", "Water cycle diagram"; ALWAYS spell terms out in full rather than as acronyms, since acronyms are ambiguous — write "Distributed file system", never "DFS"), ' +
  '"learningObjectives" (array of 2-4 strings describing what a student should be able to do after this material).';

async function buildDocumentContext(
  pageText: string,
  institutionId: string,
  teacherId: string
): Promise<DocumentContext | null> {
  if (!openai) return null;

  const cacheKey = contextCacheKey(pageText);
  const cached = await getCache<DocumentContext>(cacheKey);
  if (cached) return cached;

  const completion = await openai.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: "system", content: CONTEXT_SYSTEM_PROMPT },
      { role: "user", content: `Combined content from the selected page(s):\n${pageText}` },
    ],
    response_format: { type: "json_object" },
    max_tokens: 900,
  });

  await deductTokens(institutionId, completion.usage?.total_tokens ?? 0, teacherId);

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

export const aiScan = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const data = aiScanSchema.parse(req.body);

    if (!openai) {
      return res.json({ success: true, data: MOCK_SCAN });
    }

    await checkTokenPool(institutionId);
    const teacherId = await getTeacherId(userId, institutionId);

    // ── Stage 1+2: understand the document, once ─────────────────────────────
    // Cached by content hash, so repeat scans of the same pages (different
    // instructions, switching summary/notes) skip this entirely.
    const context = data.pageText
      ? await buildDocumentContext(data.pageText, institutionId, teacherId)
      : null;

    // ── Stage 3: interpret the instructions against that understanding ───────
    const groundingRule = "Base your answer primarily on the given material. You may draw on your own knowledge to add helpful context or clarify a concept the material only mentions briefly, but anything you add must stay consistent with the material and must never contradict it.";
    const instructionRule = "The teacher's instructions are REQUIRED reading, not optional flavor text — if given, they must visibly shape what you emphasize, how you format the output, or what you focus on (e.g. \"focus on the diagrams\" or \"summarize for a 5th grader\"). Instructions guide the output; they are never the topic.";
    const notesField = data.mode === "notes"
      ? ", detailedNotes (a thorough, well-organized written explanation of the material in multiple short paragraphs — not just a rephrasing of the bullet points, this should read like real study notes a student could learn from, covering definitions, how things work, and why they matter)"
      : "";
    const outputShape = `Return a JSON object with: topic (short string), overview (1-2 sentence summary), keyPoints (array of 4-6 concise bullet strings)${notesField}, imageCount (integer: if the teacher's instructions explicitly ask for a specific number of images use that exact number, otherwise 5). Return ONLY valid JSON, no markdown.`;

    let systemPrompt: string;
    let userContent: string;

    if (context) {
      // Generate from the structured understanding rather than re-reading the
      // raw page text: it's already been distilled, so this call stays small
      // and focused on applying the instructions.
      systemPrompt = `You are a knowledgeable teacher's assistant. You will be given a structured analysis of classroom material that has already been read and understood, plus the teacher's instructions. ${instructionRule} ${groundingRule} ${outputShape}`;
      userContent =
        `Document analysis:\n${JSON.stringify(context, null, 2)}\n\n` +
        `Teacher's instructions (optional): ${data.instructions || "None"}`;
    } else {
      // No page content (non-PDF/PPTX doc, extraction failed client-side, or
      // context extraction errored) — fall back to the previous behavior of
      // working from whatever label/instructions we have.
      systemPrompt = `You are a knowledgeable teacher's assistant. You'll be given a topic/document label and, optionally, the teacher's instructions. ${instructionRule} ${groundingRule} ${outputShape}`;
      userContent = `Topic: ${data.topic}\n\nTeacher's instructions (optional): ${data.instructions || "None"}`;
    }

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

    // Clamp to [1, 10] so one request can't fan out into an excessive number
    // of (potentially paid) image searches.
    const requestedImageCount = typeof parsed.imageCount === "number" && Number.isFinite(parsed.imageCount)
      ? Math.min(Math.max(Math.round(parsed.imageCount), 1), 10)
      : 5;

    // ── Stage 4: retrieve images from the document's own concepts ────────────
    const derivedTopic = typeof parsed.topic === "string" && parsed.topic.trim() ? parsed.topic : undefined;
    const searchContext: DocumentContext = context ?? {
      topic: derivedTopic ?? "",
      subtopics: [], keywords: [], definitions: [],
      conceptType: "", suggestedVisuals: [], learningObjectives: [],
    };
    const images = await retrieveConceptImages(searchContext, requestedImageCount);

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

    res.json({
      success: true,
      data: {
        topic: (typeof parsed.topic === "string" && parsed.topic.trim()) || searchContext.topic || "",
        overview: asText(parsed.overview) ?? "",
        keyPoints: asBullets(parsed.keyPoints),
        ...(asText(parsed.detailedNotes) ? { detailedNotes: asText(parsed.detailedNotes) } : {}),
        images,
        // Surfaced so the client can show what the AI actually understood, and
        // so a future "regenerate with different instructions" flow can reuse
        // it without re-deriving.
        context,
      },
    });
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

    // Ground the conversation in the pages actually open on the board. Reuses
    // aiScan's cached context, so this is free when those pages were already
    // scanned.
    const docContext = data.pageText
      ? await buildDocumentContext(data.pageText, institutionId, teacherId)
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
      "Skip headings and tables — the chat panel is narrow. Lead with the answer rather than restating the question.";

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

    // Same cached extraction aiScan uses — free when these pages were already
    // scanned, and gives the generator a real understanding of the material
    // rather than only the raw text.
    const quizContext = data.pageText
      ? await buildDocumentContext(data.pageText, institutionId, teacherId)
      : null;

    const systemPrompt =
      `You are a quiz generator for classroom teachers. Generate exactly ${data.count} multiple-choice questions at ${data.difficulty} difficulty. ` +
      (data.pageText
        // Without this the model drifts to its own general knowledge of the
        // subject, producing questions that are "about the topic" but test
        // things the students were never taught from these pages.
        ? `Every question MUST be answerable purely from the supplied material — test what these specific pages actually teach, not general knowledge about the subject. Do not introduce facts, terms, or examples that do not appear in the material. `
        : "") +
      `Return a JSON object with a "questions" array. Each question: ` +
      `{ "id": "q1", "question": "...", "options": ["A", "B", "C", "D"], "answer": <0-indexed correct option number>, ` +
      `"explanation": "1-2 sentences stating why the correct option is right${data.pageText ? ", grounded in what the material actually says" : ""}, and briefly why the tempting wrong option is wrong" }. ` +
      `Return ONLY valid JSON, no markdown.`;

    const userContent = data.pageText
      ? [
          quizContext ? `Document analysis:\n${JSON.stringify(quizContext, null, 2)}\n` : "",
          `Material to base the questions on:\n${data.pageText}`,
          `\nTeacher's instructions (optional): ${data.instructions || "None"}`,
        ].filter(Boolean).join("\n")
      : `Topic: ${data.topic}\n\nTeacher's instructions (optional): ${data.instructions || "None"}`;

    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      // Each question now carries an explanation on top of its options, so the
      // budget scales with question count rather than sitting at a flat cap
      // that would truncate the JSON mid-array for larger quizzes.
      max_tokens: Math.min(600 + data.count * 220, 3000),
    });

    await deductTokens(institutionId, completion.usage?.total_tokens ?? 0, teacherId);

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
        const answer = toAnswerIndex(q.answer, options);
        if (answer === null) return null;
        // Explanation is best-effort: a question is still usable without one,
        // so a missing or malformed value shouldn't discard the question.
        const explanation = typeof q.explanation === "string" && q.explanation.trim()
          ? q.explanation.trim()
          : undefined;
        return {
          id: typeof q.id === "string" && q.id.trim() ? q.id : `q${i + 1}`,
          question,
          options,
          answer,
          ...(explanation ? { explanation } : {}),
        };
      })
      .filter((q): q is { id: string; question: string; options: string[]; answer: number; explanation?: string } => q !== null);

    if (questions.length === 0) {
      throw new BadRequestError("AI returned no usable questions — please retry");
    }

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

