import crypto from "crypto";
import path from "path";
import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { BadRequestError } from "../utils/errors";
import { prisma } from "../utils/prisma";
import { getCache, setCache, delCache } from "../utils/cache";

// ── Supabase (profile pics, logos — platform-level assets) ───────────────────

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET           = process.env.SUPABASE_STORAGE_BUCKET;

// ── Cloudflare R2 (institutional data — messages, feed, class attachments) ───
//
// Required env vars:
//   R2_ENDPOINT        = https://<account-id>.r2.cloudflarestorage.com
//   R2_ACCESS_KEY_ID   = R2 API token access key
//   R2_SECRET_ACCESS_KEY = R2 API token secret key
//   R2_BUCKET_NAME     = bucket name (e.g. qubeex-institutional)
//   R2_PUBLIC_URL      = public URL base (r2.dev subdomain or custom domain)
//                        e.g. https://pub-xxxx.r2.dev  OR  https://files.yourdomain.com

const R2_ENDPOINT      = process.env.R2_ENDPOINT;        // full URL incl. https://
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY    = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET        = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL    = process.env.R2_PUBLIC_URL;

export function getR2Client(): S3Client {
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY) {
    throw new BadRequestError(
      "Cloudflare R2 is not configured. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL."
    );
  }
  try { new URL(R2_ENDPOINT); } catch {
    throw new BadRequestError(`R2_ENDPOINT is not a valid URL: "${R2_ENDPOINT}". It must be https://<account-id>.r2.cloudflarestorage.com`);
  }
  return new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    forcePathStyle: true, // required for R2 — prevents bucket name being prepended to hostname
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_KEY,
    },
  });
}

// ── File type + size limits ───────────────────────────────────────────────────

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const ALLOWED_ATTACHMENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
};

// Per-type size limits
const SIZE_LIMITS: Record<string, number> = {
  image:  5  * 1024 * 1024, //  5 MB — images
  pdf:    10 * 1024 * 1024, // 10 MB — PDFs
  video:  50 * 1024 * 1024, // 50 MB — videos (~3–5 min at 720p)
  file:   15 * 1024 * 1024, // 15 MB — doc/xls/ppt/txt
};

const SIZE_LABELS: Record<string, string> = {
  image: "5 MB", pdf: "10 MB", video: "50 MB", file: "15 MB",
};

function getAttachmentCategory(contentType: string): "image" | "pdf" | "video" | "file" {
  if (contentType.startsWith("image/"))  return "image";
  if (contentType.startsWith("video/"))  return "video";
  if (contentType === "application/pdf") return "pdf";
  return "file";
}

// Returned attachmentType stored in DB / sent to frontend
export type AttachmentType = "image" | "video" | "file";

function toAttachmentType(category: "image" | "pdf" | "video" | "file"): AttachmentType {
  if (category === "image") return "image";
  if (category === "video") return "video";
  return "file";
}

// ── Supabase helpers (profile pics, logos) ────────────────────────────────────

/**
 * Extracts the object path from a stored Supabase public/authenticated URL.
 * e.g. "https://xyz.supabase.co/storage/v1/object/public/bucket/student-photos/id/file.jpg"
 * → "student-photos/id/file.jpg"
 */
export function extractSupabasePath(storedUrl: string): string | null {
  if (!SUPABASE_URL || !SUPABASE_BUCKET) return null;
  const base = SUPABASE_URL.replace(/\/$/, "");
  for (const prefix of ["public", "authenticated"]) {
    const p = `${base}/storage/v1/object/${prefix}/${SUPABASE_BUCKET}/`;
    if (storedUrl.startsWith(p)) return storedUrl.slice(p.length);
  }
  return null;
}

/**
 * Batch-signs multiple stored Supabase avatar URLs in a single API call.
 * Returns a map of originalUrl → signedUrl for URLs that were successfully signed.
 * URLs without an avatar or that fail signing are omitted from the result.
 */
export async function generateSignedAvatarUrlsBatch(
  storedUrls: (string | null | undefined)[],
  expiresIn = 3600
): Promise<Record<string, string>> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_BUCKET) return {};

  // Extract paths, keeping track of which original URL each path came from
  const entries: { original: string; path: string }[] = [];
  for (const url of storedUrls) {
    if (!url) continue;
    const path = extractSupabasePath(url);
    if (path) entries.push({ original: url, path });
  }
  if (entries.length === 0) return {};

  try {
    const res = await fetch(
      `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/sign/${SUPABASE_BUCKET}`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ paths: entries.map(e => e.path), expiresIn }),
      }
    );
    if (!res.ok) return {};
    const data = (await res.json()) as { path: string; signedURL: string; error: string | null }[];
    const base = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1`;
    const result: Record<string, string> = {};
    for (const item of data) {
      if (!item.error && item.signedURL) {
        const entry = entries.find(e => e.path === item.path);
        if (entry) result[entry.original] = `${base}${item.signedURL}`;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Generates a short-lived signed URL for a stored Supabase avatar URL.
 * Works whether the bucket is public or private.
 * Returns null if Supabase is not configured or signing fails.
 */
export async function generateSignedAvatarUrl(
  storedAvatarUrl: string,
  expiresIn = 3600
): Promise<string | null> {
  const objectPath = extractSupabasePath(storedAvatarUrl);
  if (!objectPath || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_BUCKET) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/sign/${SUPABASE_BUCKET}/${objectPath}`,
      {
        method:  "POST",
        headers: {
          apikey:          SUPABASE_SERVICE_ROLE_KEY,
          Authorization:   `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({ expiresIn }),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { signedURL?: string };
    if (!data.signedURL) return null;
    return `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1${data.signedURL}`;
  } catch {
    return null;
  }
}

export function assertImageUpload(file: Buffer, contentType?: string) {
  if (!contentType || !IMAGE_EXTENSIONS[contentType]) {
    throw new BadRequestError("Only PNG, JPG, and WEBP images are allowed");
  }
  if (!file.length) throw new BadRequestError("Image file is required");
  if (file.length > 2 * 1024 * 1024) throw new BadRequestError("Image must be 2 MB or smaller");
}

export async function uploadImageToSupabase(
  file: Buffer,
  options: { contentType: string; folder: string; ownerId: string }
) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new BadRequestError("Supabase storage is not configured");
  }

  assertImageUpload(file, options.contentType);

  const ext        = IMAGE_EXTENSIONS[options.contentType];
  const objectPath = `${options.folder}/${options.ownerId}/${crypto.randomUUID()}.${ext}`;
  const uploadUrl  = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey:          SUPABASE_SERVICE_ROLE_KEY,
      Authorization:   `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type":  options.contentType,
      "x-upsert":      "true",
    },
    body: new Blob([new Uint8Array(file)], { type: options.contentType }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new BadRequestError(message || "Failed to upload image");
  }

  return {
    path:      objectPath,
    publicUrl: `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`,
  };
}

/**
 * Uploads a profile image / logo to R2 instead of Supabase Storage.
 *
 * Mirrors `uploadImageToSupabase`'s signature and return shape so call sites
 * only swap the function name. Lives under an `avatars/` prefix rather than
 * `institutions/{id}/` deliberately: that prefix is what `getInstitutionStorageBytes`
 * meters and what institution-deletion sweeps, and avatars have never counted
 * toward either (they were in Supabase). Keeping them outside preserves today's
 * behavior exactly — see the note in the migration discussion about wiring
 * avatars into institution-scoped cleanup as a separate change.
 *
 * R2 serves these over the public `R2_PUBLIC_URL` domain, so the returned URL
 * is stable and CDN-cacheable — unlike Supabase signed URLs, which rotate
 * hourly and defeat browser/CDN caching. The signing helpers above return
 * null for non-Supabase URLs and every call site falls back to the raw URL,
 * so these pass through untouched while legacy Supabase avatars keep signing.
 */
export async function uploadImageToR2(
  file: Buffer,
  options: { contentType: string; folder: string; ownerId: string }
): Promise<{ path: string; publicUrl: string }> {
  if (!R2_BUCKET || !R2_PUBLIC_URL) {
    throw new BadRequestError("Cloudflare R2 is not configured");
  }

  assertImageUpload(file, options.contentType);

  const ext       = IMAGE_EXTENSIONS[options.contentType];
  const objectKey = `avatars/${options.folder}/${options.ownerId}/${crypto.randomUUID()}.${ext}`;

  const client = getR2Client();
  await client.send(new PutObjectCommand({
    Bucket:      R2_BUCKET,
    Key:         objectKey,
    Body:        file,
    ContentType: options.contentType,
    // Immutable by construction — the key embeds a fresh UUID per upload, so a
    // given URL's bytes never change. Long-lived caching is what makes this
    // migration actually cut egress rather than just relocate it.
    CacheControl: "public, max-age=31536000, immutable",
  }));

  return {
    path:      objectKey,
    publicUrl: `${R2_PUBLIC_URL.replace(/\/$/, "")}/${objectKey}`,
  };
}

// ── R2 upload (institutional attachments) ────────────────────────────────────
//
// Object key structure:
//   institutions/{institutionId}/{area}/{uuid}-{safeFilename}
//
// Examples:
//   institutions/inst_abc/staffroom/posts/550e8400-filename.mp4
//   institutions/inst_abc/staffroom/dms/550e8400-filename.jpg
//   institutions/inst_abc/feed/550e8400-filename.pdf
//   institutions/inst_abc/classes/550e8400-filename.docx
//
// To wipe all data for an institution on deletion:
//   list + delete all objects with prefix  institutions/{institutionId}/

export async function uploadAttachmentToR2(
  file: Buffer,
  options: {
    originalName: string;
    contentType:  string;
    institutionId: string;
    area: string; // e.g. "staffroom/posts" | "staffroom/dms" | "feed" | "classes"
    // Blackboard's teaching-material storage has no size ceiling — teachers
    // load full lecture PDFs/decks that regularly exceed the 10/15 MB caps
    // meant for chat-style attachments (staffroom posts, DMs, feed). Every
    // other caller keeps the normal per-category limit below.
    skipSizeLimit?: boolean;
  }
): Promise<{ path: string; publicUrl: string; attachmentType: AttachmentType }> {
  if (!R2_BUCKET || !R2_PUBLIC_URL) {
    throw new BadRequestError("Cloudflare R2 is not configured");
  }

  const ext = ALLOWED_ATTACHMENT_TYPES[options.contentType];
  if (!ext) throw new BadRequestError("File type not allowed");
  if (!file.length) throw new BadRequestError("File is empty");

  const category = getAttachmentCategory(options.contentType);
  const limit    = SIZE_LIMITS[category];

  if (!options.skipSizeLimit && file.length > limit) {
    throw new BadRequestError(
      `${category === "image" ? "Image" : category === "video" ? "Video" : category === "pdf" ? "PDF" : "File"} must be ${SIZE_LABELS[category]} or smaller`
    );
  }

  const safeBasename = path
    .basename(options.originalName)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);

  const objectKey = `institutions/${options.institutionId}/${options.area}/${crypto.randomUUID()}-${safeBasename}`;

  const client = getR2Client();
  await client.send(new PutObjectCommand({
    Bucket:      R2_BUCKET,
    Key:         objectKey,
    Body:        file,
    ContentType: options.contentType,
  }));

  const publicUrl = `${R2_PUBLIC_URL.replace(/\/$/, "")}/${objectKey}`;

  // New object added — drop the cached storage total so the next read recomputes.
  await invalidateInstitutionStorage(options.institutionId);

  return { path: objectKey, publicUrl, attachmentType: toAttachmentType(category) };
}

// Keep the old Supabase attachment upload for any legacy callers during transition
export async function uploadAttachmentToSupabase(
  file: Buffer,
  options: {
    originalName: string;
    contentType: string;
    folder: string;
    ownerId: string;
  }
): Promise<{ path: string; publicUrl: string; attachmentType: AttachmentType }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new BadRequestError("Supabase storage is not configured");
  }

  const ext = ALLOWED_ATTACHMENT_TYPES[options.contentType];
  if (!ext) throw new BadRequestError("File type not allowed");
  if (!file.length) throw new BadRequestError("File is empty");

  const category = getAttachmentCategory(options.contentType);
  const limit    = SIZE_LIMITS[category];

  if (file.length > limit) {
    throw new BadRequestError(
      `${category === "image" ? "Image" : category === "video" ? "Video" : category === "pdf" ? "PDF" : "File"} must be ${SIZE_LABELS[category]} or smaller`
    );
  }

  const safeBasename = path
    .basename(options.originalName)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);

  const objectPath = `${options.folder}/${options.ownerId}/${crypto.randomUUID()}-${safeBasename}`;
  const uploadUrl  = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey:         SUPABASE_SERVICE_ROLE_KEY,
      Authorization:  `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": options.contentType,
      "x-upsert":     "true",
    },
    body: new Blob([new Uint8Array(file)], { type: options.contentType }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new BadRequestError(message || "Failed to upload file");
  }

  return {
    path:           objectPath,
    publicUrl:      `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`,
    attachmentType: toAttachmentType(category),
  };
}

// ── Deferred deletion (14-day grace period) ───────────────────────────────────

/** Extracts the R2 object key from a public URL. Returns null if not an R2 URL. */
export function r2KeyFromUrl(publicUrl: string): string | null {
  if (!R2_PUBLIC_URL || !publicUrl) return null;
  const base = R2_PUBLIC_URL.replace(/\/$/, "");
  if (!publicUrl.startsWith(base + "/")) return null;
  return publicUrl.slice(base.length + 1);
}

const DELETION_GRACE_DAYS = 14;

/** Schedule an R2 file for deletion after DELETION_GRACE_DAYS days. */
export async function scheduleR2FileDeletion(r2Key: string): Promise<void> {
  const scheduledAt = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
  await prisma.pendingFileDeletion.create({ data: { r2Key, scheduledAt } });
}

/** Delete a single object from R2 immediately. Used by the cron job. */
export async function deleteFromR2(r2Key: string): Promise<void> {
  if (!R2_BUCKET) return;
  try {
    const client = getR2Client();
    await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));
  } catch (err) {
    console.error(`[R2 delete] Failed to delete key "${r2Key}":`, err);
  }
  // Keep the cached storage total fresh — the key encodes the institution id
  // (institutions/{id}/...), so we can invalidate that institution's cache.
  const instId = r2Key.split("/")[1];
  if (r2Key.startsWith("institutions/") && instId) {
    await delCache(storageCacheKey(instId));
  }
}

const storageCacheKey = (institutionId: string) => `storage:used:${institutionId}`;

/**
 * Total bytes stored in R2 for an institution — sum of every object under
 * `institutions/{institutionId}/`. Cached in Redis (~10 min) so the paginated
 * bucket listing runs at most once per window. Returns 0 if R2 isn't configured
 * so usage meters keep rendering instead of erroring.
 */
export async function getInstitutionStorageBytes(institutionId: string): Promise<number> {
  const cacheKey = storageCacheKey(institutionId);
  const cached = await getCache<number>(cacheKey);
  if (cached != null) return cached;

  if (!R2_BUCKET || !R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY) return 0;

  const client = getR2Client();
  const prefix = `institutions/${institutionId}/`;
  let total = 0;
  let continuationToken: string | undefined;
  try {
    do {
      const res = await client.send(
        new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: continuationToken })
      );
      for (const obj of res.Contents ?? []) total += obj.Size ?? 0;
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (err) {
    console.error(`[R2 storage] Failed to sum usage for institution ${institutionId}:`, err);
    return 0;
  }

  await setCache(cacheKey, total, 600);
  return total;
}

/** Invalidate an institution's cached storage total (call after an upload/delete). */
export async function invalidateInstitutionStorage(institutionId: string): Promise<void> {
  await delCache(storageCacheKey(institutionId));
}

export const bytesToGb = (bytes: number) => bytes / 1024 ** 3;
