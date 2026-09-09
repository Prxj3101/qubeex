/**
 * One-time data migration: encrypt existing plaintext Student.aadharNo values
 * (central managed DB + every BYOD tenant DB) using fieldEncryption.service's
 * AES-256-GCM packed format.
 *
 * Safe to re-run: any value already in packed `iv.tag.cipher` format is
 * skipped, so running this twice (or against a DB that's partially migrated
 * by earlier runs / new signups written post-encryption) is a no-op for rows
 * that are already done.
 *
 * Usage:
 *   PII_ENC_KEY=<base64 key> npx tsx prisma/scripts/encryptAadharNo.ts
 *
 * Requires PII_ENC_KEY to already be set in the environment (same key the
 * running server uses — check .env). Run this ONCE per environment, ideally
 * right after deploying the code that reads/writes aadharNo through
 * fieldEncryption.service, so no window exists where old plaintext rows are
 * read by new code that doesn't expect ciphertext (decryptFieldSafe already
 * handles that gap gracefully, but shorter is better).
 */

import { prisma } from "../../src/utils/prisma";
import { getAcademicClient, ByodUnavailableError } from "../../src/services/tenantDb.service";
import { encryptField, isFieldEncryptionConfigured } from "../../src/services/fieldEncryption.service";

// Packed ciphertext is always exactly 3 dot-separated base64 segments.
// Plaintext Aadhaar numbers (12 digits, or however users typed them) never
// match this shape, so this doubles as the idempotency check.
function isAlreadyEncrypted(value: string): boolean {
  return value.split(".").length === 3;
}

async function migrateInstitution(institutionId: string, institutionName: string) {
  let client;
  try {
    client = await getAcademicClient(institutionId);
  } catch (err) {
    if (err instanceof ByodUnavailableError) {
      console.warn(`  [SKIP] ${institutionName} (${institutionId}): BYOD DB unavailable - ${err.message}`);
      return { scanned: 0, encrypted: 0, skipped: 0, failed: 0 };
    }
    throw err;
  }

  const students = await client.student.findMany({
    where: { institutionId, aadharNo: { not: null } },
    select: { id: true, aadharNo: true },
  });

  let encrypted = 0;
  let skipped = 0;
  let failed = 0;

  for (const s of students) {
    if (!s.aadharNo) continue;
    if (isAlreadyEncrypted(s.aadharNo)) {
      skipped++;
      continue;
    }
    try {
      const packed = encryptField(s.aadharNo);
      await client.student.update({ where: { id: s.id }, data: { aadharNo: packed } });
      encrypted++;
    } catch (err) {
      failed++;
      console.error(`  [FAIL] student ${s.id} in ${institutionName}:`, err instanceof Error ? err.message : err);
    }
  }

  return { scanned: students.length, encrypted, skipped, failed };
}

async function main() {
  if (!isFieldEncryptionConfigured()) {
    console.error("PII_ENC_KEY is not set. Aborting - set it in the environment before running this script.");
    process.exit(1);
  }

  const institutions = await prisma.institution.findMany({ select: { id: true, name: true } });
  console.log(`Found ${institutions.length} institution(s). Starting aadharNo encryption migration...\n`);

  let totalScanned = 0;
  let totalEncrypted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const inst of institutions) {
    console.log(`Institution: ${inst.name} (${inst.id})`);
    const result = await migrateInstitution(inst.id, inst.name);
    totalScanned += result.scanned;
    totalEncrypted += result.encrypted;
    totalSkipped += result.skipped;
    totalFailed += result.failed;
    console.log(
      `  scanned=${result.scanned} encrypted=${result.encrypted} already-encrypted=${result.skipped} failed=${result.failed}\n`
    );
  }

  console.log("Done.");
  console.log(
    `Totals: scanned=${totalScanned} encrypted=${totalEncrypted} already-encrypted=${totalSkipped} failed=${totalFailed}`
  );

  if (totalFailed > 0) {
    console.error(`${totalFailed} row(s) failed to encrypt - re-run this script to retry them (it's idempotent).`);
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("Migration script crashed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
