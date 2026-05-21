import crypto from "crypto";
import path from "path";
import { BadRequestError } from "../utils/errors";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET;

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
};

const IMAGE_MIME_PREFIX = "image/";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;       // 5 MB

export function assertImageUpload(file: Buffer, contentType?: string) {
  if (!contentType || !IMAGE_EXTENSIONS[contentType]) {
    throw new BadRequestError("Only PNG, JPG, and WEBP images are allowed");
  }

  if (!file.length) {
    throw new BadRequestError("Image file is required");
  }

  if (file.length > 2 * 1024 * 1024) {
    throw new BadRequestError("Image must be 2MB or smaller");
  }
}

export async function uploadImageToSupabase(
  file: Buffer,
  options: {
    contentType: string;
    folder: string;
    ownerId: string;
  }
) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new BadRequestError("Supabase storage is not configured");
  }

  assertImageUpload(file, options.contentType);

  const extension = IMAGE_EXTENSIONS[options.contentType];
  const objectPath = `${options.folder}/${options.ownerId}/${crypto.randomUUID()}.${extension}`;
  const uploadUrl = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": options.contentType,
      "x-upsert": "true",
    },
    body: new Blob([new Uint8Array(file)], { type: options.contentType }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new BadRequestError(message || "Failed to upload image");
  }

  return {
    path: objectPath,
    publicUrl: `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`,
  };
}

export async function uploadAttachmentToSupabase(
  file: Buffer,
  options: {
    originalName: string;
    contentType: string;
    folder: string;
    ownerId: string;
  }
): Promise<{ path: string; publicUrl: string; attachmentType: "image" | "file" }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new BadRequestError("Supabase storage is not configured");
  }

  const ext = ALLOWED_ATTACHMENT_TYPES[options.contentType];
  if (!ext) {
    throw new BadRequestError("File type not allowed");
  }

  const isImage = options.contentType.startsWith(IMAGE_MIME_PREFIX);
  const limit = isImage ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
  if (file.length > limit) {
    throw new BadRequestError(
      isImage ? "Image must be 5 MB or smaller" : "File must be 10 MB or smaller"
    );
  }
  if (!file.length) {
    throw new BadRequestError("File is empty");
  }

  const safeBasename = path
    .basename(options.originalName)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);

  const objectPath = `${options.folder}/${options.ownerId}/${crypto.randomUUID()}-${safeBasename}`;
  const uploadUrl = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": options.contentType,
      "x-upsert": "true",
    },
    body: new Blob([new Uint8Array(file)], { type: options.contentType }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new BadRequestError(message || "Failed to upload file");
  }

  return {
    path: objectPath,
    publicUrl: `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`,
    attachmentType: isImage ? "image" : "file",
  };
}
