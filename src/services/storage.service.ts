import crypto from "crypto";
import { BadRequestError } from "../utils/errors";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

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
