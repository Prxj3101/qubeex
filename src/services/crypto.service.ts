import crypto from "crypto";

// AES-256-GCM encryption for secrets at rest (BYOD database credentials).
// Key comes from BYOD_ENC_KEY — a base64-encoded 32-byte key. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const raw = process.env.BYOD_ENC_KEY;
  if (!raw) {
    throw new Error("BYOD_ENC_KEY is not set. Provide a base64-encoded 32-byte key.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("BYOD_ENC_KEY must decode to exactly 32 bytes (256-bit).");
  }
  return key;
}

export interface EncryptedSecret {
  cipher: string; // base64
  iv: string; // base64
  tag: string; // base64
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit nonce recommended for GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(secret.iv, "base64"));
  decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(secret.cipher, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** True when a BYOD_ENC_KEY is configured (used to guard the feature gracefully). */
export function isEncryptionConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}
