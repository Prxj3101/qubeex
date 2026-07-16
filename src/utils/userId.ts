import { prisma } from "./prisma";
import type { Prisma } from "../generated/prisma/client";

type Db = typeof prisma | Prisma.TransactionClient;

const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// 4-letter code from initials of the institution name's words, uppercased,
// padded with 'X' if the name has fewer than 4 words.
// "St Xavier's High School" -> "SXHS"; "Delhi Public School" -> "DPSX"
export function deriveInstitutionPrefix(name: string): string {
  const words = name.split(/\s+/).filter((w) => w.length > 0);
  const letters = words.slice(0, 4).map((w) => w[0]!.toUpperCase());
  while (letters.length < 4) letters.push("X");
  return letters.join("");
}

// 2-char alphanumeric disambiguator, true base-36 (1 -> "01", 36 -> "10", 1295 -> "ZZ").
// Counting starts at 1 (not 0) so the first institution reads "01", not "00" —
// this costs the theoretical top slot, so max capacity is 1,295, not 1,296.
export function encodeDisambiguator(n: number): string {
  if (n < 1 || n > 1295) throw new Error("Disambiguator out of range (max 1,295 institutions per prefix)");
  const d1 = Math.floor(n / 36);
  const d0 = n % 36;
  return BASE36[d1] + BASE36[d0];
}

// 4-char sequence: plain zero-padded decimal for 1-9999 (matches "0001".."9999"
// exactly), then rolls into alphanumeric base-36 from 10000 onward so the
// 10,000th value is "000A", the 10,001st is "000B", etc. Total capacity ~1.68M.
export function encodeSequence(n: number): string {
  if (n < 1) throw new Error("Sequence must be >= 1");
  if (n <= 9999) return String(n).padStart(4, "0");

  let carry = n - 10000 + 10; // 'A' occupies base-36 digit value 10
  const digits = [0, 0, 0, 0];
  for (let pos = 3; pos >= 0; pos--) {
    digits[pos] = carry % 36;
    carry = Math.floor(carry / 36);
  }
  if (carry > 0) throw new Error("Sequence exceeds maximum capacity (~1.68M)");
  return digits.map((d) => BASE36[d]).join("");
}

function joinYearOf(createdAt: Date): string {
  return String(createdAt.getFullYear()).slice(-2);
}

async function ensureInstitutionUserIdBase(
  institutionId: string,
  db: Db
): Promise<{ prefix: string; disambiguator: string; joinYear: string }> {
  const inst = await db.institution.findUniqueOrThrow({ where: { id: institutionId } });
  if (inst.userIdPrefix && inst.userIdDisambiguator) {
    return { prefix: inst.userIdPrefix, disambiguator: inst.userIdDisambiguator, joinYear: joinYearOf(inst.createdAt) };
  }

  // The 4-letter prefix is normally provided explicitly by the superadmin at
  // institution-creation time (Institution.userIdPrefix, set directly on
  // create). Falling back to a name-derived prefix only covers institutions
  // created before that field existed.
  const prefix = inst.userIdPrefix ?? deriveInstitutionPrefix(inst.name);
  const siblingCount = await db.institution.count({ where: { userIdPrefix: prefix, id: { not: institutionId } } });
  const disambiguator = encodeDisambiguator(siblingCount + 1);

  await db.institution.update({
    where: { id: institutionId },
    data: { userIdPrefix: prefix, userIdDisambiguator: disambiguator },
  });

  return { prefix, disambiguator, joinYear: joinYearOf(inst.createdAt) };
}

async function bumpSequence(institutionId: string, role: "A" | "T" | "S", db: Db): Promise<number> {
  if (role === "A") {
    const u = await db.institution.update({
      where: { id: institutionId },
      data: { nextAdminSeq: { increment: 1 } },
      select: { nextAdminSeq: true },
    });
    return u.nextAdminSeq;
  }
  if (role === "T") {
    const u = await db.institution.update({
      where: { id: institutionId },
      data: { nextTeacherSeq: { increment: 1 } },
      select: { nextTeacherSeq: true },
    });
    return u.nextTeacherSeq;
  }
  const u = await db.institution.update({
    where: { id: institutionId },
    data: { nextStudentSeq: { increment: 1 } },
    select: { nextStudentSeq: true },
  });
  return u.nextStudentSeq;
}

/**
 * Generates the next user ID for an institution + role, in the fixed
 * XXXX-XXXXX-XXXX format: {prefix}-{disambiguator}{role}{joinYear}-{sequence}.
 * Role is "A" for ADMIN/SUB_ADMIN, "T" for TEACHER, "S" for STUDENT.
 * The institution's prefix/disambiguator are computed once (lazily, on first
 * call) and reused for every subsequent user. The sequence counter is a
 * persistent per-institution+role counter that only ever increases.
 */
export async function generateUserId(
  institutionId: string,
  role: "A" | "T" | "S",
  db: Db = prisma
): Promise<string> {
  const { prefix, disambiguator, joinYear } = await ensureInstitutionUserIdBase(institutionId, db);
  const seq = await bumpSequence(institutionId, role, db);
  return `${prefix}-${disambiguator}${role}${joinYear}-${encodeSequence(seq)}`;
}
