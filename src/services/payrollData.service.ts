// Small shared payroll data helpers used by both the payroll and staff
// controllers (kept here to avoid a circular import between them).
import { academicDb } from "../utils/academicContext";
import { prisma } from "../utils/prisma";
import { generateSignedAvatarUrlsBatch } from "./storage.service";
import { BadRequestError } from "../utils/errors";
import { encryptField, decryptFieldSafe, isFieldEncryptionConfigured } from "./fieldEncryption.service";
import type { CalcComponent, CalcType, ComponentType, DayBasis } from "./payrollCalc.service";

export interface BankDetails {
  accountName: string;
  accountNumber: string;
  ifsc: string;
  bankName: string;
}

export async function loadPayrollSettings(institutionId: string): Promise<{ dayBasis: DayBasis; payDay: number }> {
  const s = await academicDb().payrollSettings.findUnique({ where: { institutionId } });
  return { dayBasis: (s?.dayBasis as DayBasis) ?? "CALENDAR", payDay: s?.payDay ?? 1 };
}

export async function loadComponents(institutionId: string): Promise<CalcComponent[]> {
  const rows = await academicDb().salaryComponent.findMany({
    where: { institutionId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type as ComponentType,
    calcType: c.calcType as CalcType,
    isBasic: c.isBasic,
    lopApplicable: c.lopApplicable,
    sortOrder: c.sortOrder,
  }));
}

// Staff.bankDetails is an encrypted JSON string. Returns null when empty or
// unreadable (never throws — a bad row shouldn't break a whole payroll list).
export function readStaffBankDetails(stored: string | null | undefined): BankDetails | null {
  if (!stored) return null;
  try {
    const plain = decryptFieldSafe(stored);
    if (!plain) return null;
    const parsed = JSON.parse(plain) as Partial<BankDetails>;
    return {
      accountName: parsed.accountName ?? "",
      accountNumber: parsed.accountNumber ?? "",
      ifsc: parsed.ifsc ?? "",
      bankName: parsed.bankName ?? "",
    };
  } catch {
    return null;
  }
}

// Encrypts bank details for storage. `null` clears them; all-blank also clears.
export function writeStaffBankDetails(details: BankDetails | null): string | null {
  if (!details) return null;
  const blank = !details.accountName.trim() && !details.accountNumber.trim() && !details.ifsc.trim() && !details.bankName.trim();
  if (blank) return null;
  if (!isFieldEncryptionConfigured()) {
    throw new BadRequestError("Bank details can't be saved: encryption key (PII_ENC_KEY) is not configured on the server");
  }
  return encryptField(JSON.stringify({
    accountName: details.accountName.trim(),
    accountNumber: details.accountNumber.trim(),
    ifsc: details.ifsc.trim().toUpperCase(),
    bankName: details.bankName.trim(),
  }));
}

// Photo + designation/title from each linked person's QubeEx profile:
// Teacher (avatarUrl, title), SubAdmin (avatarUrl, designation), and the
// institution admin (Institution.adminAvatarUrl / adminTitle). Photos are
// returned as signed URLs, same as the teacher / sub-admin lists.
export async function loadLinkedProfiles(institutionId: string, userIds: string[]) {
  const out = new Map<string, { avatarUrl: string | null; designation: string | null }>();
  if (userIds.length === 0) return out;

  const [users, teachers, subAdmins, institution] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, role: true } }),
    academicDb().teacher.findMany({ where: { userId: { in: userIds } }, select: { userId: true, avatarUrl: true, title: true } }),
    prisma.subAdmin.findMany({ where: { userId: { in: userIds } }, select: { userId: true, avatarUrl: true, designation: true } }),
    prisma.institution.findUnique({ where: { id: institutionId }, select: { adminAvatarUrl: true, adminTitle: true } }),
  ]);

  const raw = new Map<string, { avatarUrl: string | null; designation: string | null }>();
  for (const t of teachers) raw.set(t.userId, { avatarUrl: t.avatarUrl ?? null, designation: t.title ?? null });
  for (const sa of subAdmins) raw.set(sa.userId, { avatarUrl: sa.avatarUrl ?? null, designation: sa.designation ?? null });
  for (const u of users) {
    if (u.role === "ADMIN" && !raw.has(u.id)) {
      raw.set(u.id, { avatarUrl: institution?.adminAvatarUrl ?? null, designation: institution?.adminTitle ?? null });
    }
  }

  const signed = await generateSignedAvatarUrlsBatch([...raw.values()].map((p) => p.avatarUrl));
  for (const [userId, p] of raw) {
    out.set(userId, { avatarUrl: p.avatarUrl ? signed[p.avatarUrl] ?? p.avatarUrl : null, designation: p.designation?.trim() || null });
  }
  return out;
}
