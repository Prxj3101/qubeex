// Small shared payroll data helpers used by both the payroll and staff
// controllers (kept here to avoid a circular import between them).
import { academicDb } from "../utils/academicContext";
import { prisma } from "../utils/prisma";
import { generateSignedAvatarUrlsBatch } from "./storage.service";
import { BadRequestError } from "../utils/errors";
import { encryptField, decryptFieldSafe, isFieldEncryptionConfigured } from "./fieldEncryption.service";
import type { CalcComponent, CalcType, ComponentType, DayBasis, PfConfig, EsiConfig, PtConfig, PtSlab } from "./payrollCalc.service";

export interface BankDetails {
  accountName: string;
  accountNumber: string;
  ifsc: string;
  bankName: string;
}

export interface PayrollSettingsData {
  dayBasis: DayBasis;
  payDay: number;
  pfEnabled: boolean;
  pf: PfConfig; // rules used when PF applies
  esiEnabled: boolean;
  esi: EsiConfig;
  ptEnabled: boolean;
  ptState: string | null;
  pt: PtConfig;
  tdsEnabled: boolean;
}

// Maharashtra Professional Tax (men's slab): up to ₹7,500 nil, ₹7,501-10,000 ₹175,
// above ₹10,000 ₹200 (₹300 in February) - ₹2,500 a year. Women earning up to
// ₹25,000 are exempt: switch PT off for them on the Staff page.
export const PT_PRESETS: Record<string, PtSlab[]> = {
  MAHARASHTRA: [
    { from: 0, amount: 0 },
    { from: 750100, amount: 17500 },
    { from: 1000100, amount: 20000, febAmount: 30000 },
  ],
};

export async function loadPayrollSettings(institutionId: string): Promise<PayrollSettingsData> {
  const s = await academicDb().payrollSettings.findUnique({ where: { institutionId } });
  return {
    dayBasis: (s?.dayBasis as DayBasis) ?? "CALENDAR",
    payDay: s?.payDay ?? 1,
    pfEnabled: s?.pfEnabled ?? false,
    pf: {
      ceiling: s?.pfCeiling ?? 2500000,
      capWages: s?.pfCapWages ?? true,
      employeeRate: s?.pfEmployeeRate ?? 1200,
      employerRate: s?.pfEmployerRate ?? 1200,
      epsRate: s?.pfEpsRate ?? 833,
      edliRate: s?.pfEdliRate ?? 50,
      adminRate: s?.pfAdminRate ?? 50,
    },
    esiEnabled: s?.esiEnabled ?? false,
    esi: {
      wageLimit: s?.esiWageLimit ?? 2100000,
      employeeRate: s?.esiEmployeeRate ?? 75,
      employerRate: s?.esiEmployerRate ?? 325,
    },
    ptEnabled: s?.ptEnabled ?? false,
    ptState: s?.ptState ?? null,
    tdsEnabled: s?.tdsEnabled ?? false,
    pt: { slabs: Array.isArray(s?.ptSlabs) && (s!.ptSlabs as unknown[]).length ? (s!.ptSlabs as unknown as PtSlab[]) : (PT_PRESETS[s?.ptState ?? ""] ?? []) },
  };
}

// All statutory rules (PF / ESI / PT) for one person, ready to pass to calculateSalary.
export function statutoryFor(
  settings: PayrollSettingsData,
  staff: { pfApplicable?: boolean | null; epsApplicable?: boolean | null; esiApplicable?: boolean | null; ptApplicable?: boolean | null } | null | undefined,
): { pf: PfConfig | null; esi: EsiConfig | null; pt: PtConfig | null } {
  return {
    pf: pfFor(settings, staff),
    esi: settings.esiEnabled && staff?.esiApplicable !== false ? settings.esi : null,
    pt: settings.ptEnabled && staff?.ptApplicable !== false && settings.pt.slabs.length ? settings.pt : null,
  };
}

// PF rules for one person: only when the school has PF on and the person isn't excluded.
// No EPS for this person (e.g. 58+): EPS rate 0, so the whole employer 12% goes to EPF.
export function pfFor(settings: PayrollSettingsData, staff: { pfApplicable?: boolean | null; epsApplicable?: boolean | null } | null | undefined): PfConfig | null {
  if (!settings.pfEnabled || staff?.pfApplicable === false) return null;
  return staff?.epsApplicable === false ? { ...settings.pf, epsRate: 0 } : settings.pf;
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
    pfApplicable: c.pfApplicable,
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
