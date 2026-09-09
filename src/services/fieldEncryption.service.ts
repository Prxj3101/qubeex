import crypto from "crypto";

// AES-256-GCM field-level encryption for sensitive Student PII (Aadhaar
// number, phone, address, etc.) stored in plain `String?` Prisma columns.
// Deliberately a SEPARATE key from crypto.service.ts's BYOD_ENC_KEY (which
// protects BYOD database credentials) — different blast radius, different
// rotation schedule. Key comes from PII_ENC_KEY — a base64-encoded 32-byte
// key. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Unlike crypto.service.ts's {cipher, iv, tag} object shape, this packs
// everything into ONE string (iv.tag.cipher, all base64, dot-separated) so
// it drops straight into an existing `String?` column with no schema change
// — e.g. Student.aadharNo goes from holding plaintext to holding this packed
// string, same column type, same type in Prisma.

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce recommended for GCM

function getKey(): Buffer {
  const raw = process.env.PII_ENC_KEY;
  if (!raw) {
    throw new Error("PII_ENC_KEY is not set. Provide a base64-encoded 32-byte key.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("PII_ENC_KEY must decode to exactly 32 bytes (256-bit).");
  }
  return key;
}

/** True when a PII_ENC_KEY is configured (used to guard the feature gracefully). */
export function isFieldEncryptionConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypts a plaintext string for storage. Returns a single packed string
 * safe to store directly in a `String?` Prisma column.
 */
export function encryptField(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

/**
 * Decrypts a string previously produced by `encryptField`. Throws if the
 * value isn't in the expected packed format or fails auth-tag verification
 * (tampered/corrupted ciphertext, or wrong key).
 */
export function decryptField(packed: string): string {
  const key = getKey();
  const parts = packed.split(".");
  if (parts.length !== 3) {
    throw new Error("decryptField: value is not in the expected iv.tag.cipher format.");
  }
  const [ivB64, tagB64, cipherB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Best-effort decrypt for read paths — if the stored value isn't actually
 * encrypted yet (e.g. rows written before this feature existed, or the
 * one-time migration hasn't run against this DB yet), returns it as-is
 * instead of throwing, so a partially-migrated dataset doesn't 500 every
 * request. Once the migration has run everywhere, every value should be in
 * packed format and this fallback becomes a no-op safety net.
 */
export function decryptFieldSafe(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  // Packed format is always exactly 3 dot-separated base64 segments —
  // plaintext values (old un-migrated rows) essentially never match this
  // shape by accident.
  if (value.split(".").length !== 3) return value;
  try {
    return decryptField(value);
  } catch {
    return value;
  }
}

/**
 * Encrypts a single optional/nullable string field for a Prisma update/create
 * payload. `undefined` (field not present in the request) passes through as
 * `undefined` so callers can filter it out and leave the column untouched;
 * `null`/`""` becomes `null` (explicitly clearing the field); anything else
 * is encrypted.
 */
export function encryptOptionalField(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return encryptField(value);
}

// Student.guardians is a Json array of these — only `number` (the guardian's
// phone number) is sensitive enough to encrypt; name/relation stay plaintext
// so the column stays human-scannable and no schema/type change is needed.
export interface GuardianEntry {
  name: string;
  number: string;
  relation: string;
}

export function encryptGuardians(
  guardians: GuardianEntry[] | null | undefined
): GuardianEntry[] | null | undefined {
  if (guardians === undefined) return undefined;
  if (guardians === null) return null;
  return guardians.map((g) => (g && g.number ? { ...g, number: encryptField(g.number) } : g));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decryptGuardians(guardians: any): any {
  if (!Array.isArray(guardians)) return guardians;
  return guardians.map((g) =>
    g && typeof g === "object" ? { ...g, number: decryptFieldSafe(g.number) } : g
  );
}

// The Student PII fields that get encrypted at rest, beyond aadharNo.
interface StudentPIIInput {
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  pincode?: string | null;
  aadharNo?: string | null;
  panNo?: string | null;
  emergencyContact?: string | null;
  guardians?: GuardianEntry[] | null;
}

/**
 * Builds the subset of a Prisma `data: {...}` object for the encrypted
 * Student PII fields, encrypting each one that's present in `input` and
 * omitting keys that are `undefined` (so spreading the result into an update
 * never accidentally clears a field the caller didn't touch).
 */
export function buildStudentPIIUpdate(input: StudentPIIInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const simpleFields: (keyof StudentPIIInput)[] = [
    "phone",
    "address",
    "city",
    "pincode",
    "aadharNo",
    "panNo",
    "emergencyContact",
  ];
  for (const key of simpleFields) {
    const value = input[key];
    if (value === undefined) continue;
    out[key] = encryptOptionalField(value as string | null);
  }
  if (input.guardians !== undefined) {
    out.guardians = encryptGuardians(input.guardians);
  }
  return out;
}

/**
 * Returns the decrypted versions of every encrypted Student PII field found
 * on `student`, for spreading over a Student record before sending it in a
 * response (e.g. `{ ...student, ...decryptStudentPII(student) }`).
 */
export function decryptStudentPII<
  T extends {
    phone?: string | null;
    address?: string | null;
    city?: string | null;
    pincode?: string | null;
    aadharNo?: string | null;
    panNo?: string | null;
    emergencyContact?: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guardians?: any;
  },
>(student: T) {
  return {
    phone: decryptFieldSafe(student.phone),
    address: decryptFieldSafe(student.address),
    city: decryptFieldSafe(student.city),
    pincode: decryptFieldSafe(student.pincode),
    aadharNo: decryptFieldSafe(student.aadharNo),
    panNo: decryptFieldSafe(student.panNo),
    emergencyContact: decryptFieldSafe(student.emergencyContact),
    guardians: decryptGuardians(student.guardians),
  };
}
