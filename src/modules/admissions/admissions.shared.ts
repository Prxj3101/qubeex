import { randomBytes } from "node:crypto";
import { z } from "zod";
import { academicDb } from "../../utils/academicContext";
import { getCurrentAcademicYear, getNextAcademicYear } from "../../utils/academicYear";
import { encryptField, decryptFieldSafe } from "../../services/fieldEncryption.service";
import { admissionFormSchema } from "./admissions.form";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";
import type { Prisma } from "../../generated/prisma/client";

// ── Stages ──────────────────────────────────────────────────────────────────
// The board's columns, in the order a school office works through them.
export const STAGES = ["ENQUIRY", "REGISTERED", "INTERACTION", "SELECTED", "ADMITTED"] as const;
export type Stage = (typeof STAGES)[number];
// A closed application keeps its stage but carries one of these.
export const OUTCOMES = ["WAITLIST", "NOT_SELECTED", "WITHDRAWN", "LAPSED"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const SOURCES = ["ONLINE", "COUNTER", "PHONE"] as const;

// ── Settings shapes ─────────────────────────────────────────────────────────
export const FIELD_KEYS = ["bloodGroup", "previousSchool", "address", "sibling", "transport", "religion", "category", "motherTongue"] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export const DEFAULT_FIELDS: Record<FieldKey, boolean> = {
  bloodGroup: true, previousSchool: true, address: true, sibling: true, transport: true, religion: false, category: false, motherTongue: false,
};

export const DEFAULT_DOCUMENTS = [
  { id: "birth", name: "Birth certificate", required: true },
  { id: "tc", name: "Transfer Certificate (TC)", required: false },
  { id: "report", name: "Previous school report card / marksheet", required: false },
  { id: "migration", name: "Migration certificate (other board)", required: false },
  { id: "aadhaar_child", name: "Aadhaar of child", required: false },
  { id: "aadhaar_parents", name: "Aadhaar of parents", required: false },
  { id: "photos", name: "Passport photos (child and parents)", required: true },
  { id: "address", name: "Address proof", required: false },
  { id: "medical", name: "Medical / fitness certificate", required: false },
  { id: "caste", name: "Caste certificate (if applicable)", required: false },
  { id: "income", name: "Income certificate (RTE / EWS)", required: false },
  { id: "disability", name: "Disability certificate (if applicable)", required: false },
  { id: "character", name: "Character certificate", required: false },
  { id: "pen", name: "PEN / APAAR ID", required: false },
];

export const settingsSchema = z.object({
  academicYearId: z.string().uuid().nullable().optional(),
  formOpen: z.boolean().optional(),
  interactionStep: z.boolean().optional(),
  registrationFee: z.number().min(0).max(10_000_000).nullable().optional(),
  admissionFeeDays: z.number().int().min(1).max(90).optional(),
  ageCutoff: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).optional(),
  ageRules: z.array(z.object({ standardId: z.string().uuid(), minMonths: z.number().int().min(0).max(300), maxMonths: z.number().int().min(0).max(300).nullable().optional() })).max(60).optional(),
  fields: z.partialRecord(z.enum(FIELD_KEYS), z.boolean()).optional(),
  questions: z.array(z.object({ id: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(160), required: z.boolean() })).max(10).optional(),
  documents: z.array(z.object({ id: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(120), required: z.boolean() })).max(40).optional(),
  admissionNoPrefix: z.string().trim().max(20).optional(),
  nextAdmissionNo: z.number().int().min(1).max(9_999_999).optional(),
  admissionForm: admissionFormSchema.optional(),
  revision: z.number().int().min(1),
}).strict();

// "+91 9876543210" (country code + number) or a bare Indian 10 digit number.
// India must have exactly 10 digits; other codes 8 to 10.
const PHONE_RE = /^(?:(?:\+91 )?\d{10}|\+(?!91 )\d{1,4} \d{8,10})$/;

// ── Application details (stored encrypted) ─────────────────────────────────
export const detailsSchema = z.object({
  phone: z.string().trim().regex(PHONE_RE, "Enter a valid mobile number"),
  email: z.string().trim().toLowerCase().email().max(160).or(z.literal("")).default(""),
  fatherName: z.string().trim().max(100).default(""),
  motherName: z.string().trim().max(100).default(""),
  guardianName: z.string().trim().max(100).default(""),
  altPhone: z.string().trim().refine(v => v === "" || PHONE_RE.test(v), "Enter a valid mobile number").default(""),
  address: z.string().trim().max(300).default(""),
  city: z.string().trim().max(80).default(""),
  pincode: z.string().trim().max(10).default(""),
  bloodGroup: z.string().trim().max(5).default(""),
  previousSchool: z.string().trim().max(160).default(""),
  sibling: z.string().trim().max(160).default(""),
  transport: z.string().trim().max(160).default(""),
  religion: z.string().trim().max(40).default(""),
  category: z.string().trim().max(40).default(""),
  motherTongue: z.string().trim().max(40).default(""),
  answers: z.record(z.string().max(40), z.string().trim().max(500)).default({}),
  notes: z.string().trim().max(1000).default(""),
});
export type Details = z.infer<typeof detailsSchema>;

/**
 * The "Need the school bus?" answer, kept in `details.transport`:
 * "" not answered, "No", "Yes", or the pickup area (which means yes).
 * Older free-text answers ("Nallasopara West") read as yes + that area.
 */
export function busNeed(transport: string | null | undefined): { need: boolean | null; area: string } {
  const v = (transport ?? "").trim();
  if (!v) return { need: null, area: "" };
  if (/^no$/i.test(v)) return { need: false, area: "" };
  if (/^yes$/i.test(v)) return { need: true, area: "" };
  return { need: true, area: v };
}

export const childSchema = z.object({
  childName: z.string().trim().min(1, "Enter the child's name").max(100),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date of birth").nullable().optional(),
  gender: z.enum(["Male", "Female", "Other"]).nullable().optional(),
  standardId: z.string().uuid("Pick a class"),
});

export const encryptDetails = (d: Details) => encryptField(JSON.stringify(d));
// Reading back is lenient so older records with other phone formats still open.
const storedDetailsSchema = detailsSchema.extend({ phone: z.string().default(""), altPhone: z.string().default("") });
export function decryptDetails(packed: string): Details {
  try { return storedDetailsSchema.parse(JSON.parse(decryptFieldSafe(packed) ?? "{}")); }
  catch { return storedDetailsSchema.parse({}); }
}
export const parentLabel = (d: Details) => d.motherName || d.fatherName || d.guardianName || "";
export const last4 = (phone: string) => phone.replace(/\D/g, "").slice(-4);
export const newToken = () => randomBytes(24).toString("base64url");

// ── Events ──────────────────────────────────────────────────────────────────
export type AdmissionEvent = { action: string; at: string; by: string; note?: string };
export const withEvent = (events: unknown, action: string, by: string, note?: string): Prisma.InputJsonValue => {
  const list = Array.isArray(events) ? (events as AdmissionEvent[]) : [];
  return [...list, { action, at: new Date().toISOString(), by, ...(note ? { note } : {}) }].slice(-200) as unknown as Prisma.InputJsonValue;
};

/** Note of the latest history entry for this action (e.g. the reason for "Not selected"). */
export function lastNote(events: unknown, action: string): string | undefined {
  const list = Array.isArray(events) ? (events as AdmissionEvent[]) : [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].action === action) return list[i].note || undefined;
  return undefined;
}

// ── Settings access ─────────────────────────────────────────────────────────
export async function getSettings(institutionId: string) {
  const db = academicDb();
  const existing = await db.admissionSettings.findUnique({ where: { institutionId } });
  if (existing) return existing;
  try {
    return await db.admissionSettings.create({
      data: { institutionId, fields: DEFAULT_FIELDS, documents: DEFAULT_DOCUMENTS },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      const again = await db.admissionSettings.findUnique({ where: { institutionId } });
      if (again) return again;
    }
    throw err;
  }
}

/** The session admissions are taken for: the configured one, else next session. */
export async function targetYear(institutionId: string, configured: string | null) {
  const db = academicDb();
  const current = await getCurrentAcademicYear(institutionId);
  if (configured) {
    const year = await db.academicYear.findFirst({ where: { id: configured, institutionId } });
    // A session that has already ended is never the admission session any more:
    // once 2027-28 starts, a school still set to 2026-27 moves on by itself.
    if (year && year.startDate >= current.startDate) return year;
  }
  return getNextAcademicYear(institutionId, current);
}

/** Past sessions are kept for history and are read only. */
export async function isPastSession(institutionId: string, academicYearId: string) {
  const [year, current] = await Promise.all([
    academicDb().academicYear.findFirst({ where: { id: academicYearId, institutionId }, select: { startDate: true } }),
    getCurrentAcademicYear(institutionId),
  ]);
  return !!year && year.startDate < current.startDate;
}

export async function assertOpenSession(institutionId: string, academicYearId: string) {
  if (await isPastSession(institutionId, academicYearId)) throw new BadRequestError("This session is over. Its admissions are kept for history and cannot be changed.");
}

/** Sessions an admin can choose: the current one and the next one. */
export async function sessionChoices(institutionId: string) {
  const current = await getCurrentAcademicYear(institutionId);
  const next = await getNextAcademicYear(institutionId, current);
  return [
    { id: current.id, label: current.label, isCurrent: true },
    { id: next.id, label: next.label, isCurrent: false },
  ];
}

export async function nextApplicationNo(institutionId: string, yearLabel: string) {
  const s = await academicDb().admissionSettings.update({
    where: { institutionId }, data: { nextApplicationNo: { increment: 1 } }, select: { nextApplicationNo: true },
  });
  const n = s.nextApplicationNo - 1;
  return `ADM-${(yearLabel.match(/\d{4}/)?.[0]) ?? new Date().getFullYear()}-${String(n).padStart(4, "0")}`;
}

export async function takeAdmissionNo(institutionId: string) {
  const s = await academicDb().admissionSettings.update({
    // revision moves too, so a settings screen opened earlier cannot save the old counter back.
    where: { institutionId }, data: { nextAdmissionNo: { increment: 1 }, revision: { increment: 1 } }, select: { nextAdmissionNo: true, admissionNoPrefix: true },
  });
  return `${s.admissionNoPrefix}${String(s.nextAdmissionNo - 1).padStart(4, "0")}`;
}

/** "LKG" + "A" -> "LKG A", but "LKG" + "LKG-A" stays "LKG-A". */
export const sectionLabel = (standard: string, division: string) =>
  division.toLowerCase().startsWith(standard.toLowerCase()) ? division : `${standard} ${division}`;

// ── Age check ───────────────────────────────────────────────────────────────
export function ageInMonths(dob: string, cutoffYear: number, cutoff: string): number | null {
  const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [cm, cd] = cutoff.split("-").map(Number);
  const by = Number(m[1]), bm = Number(m[2]), bd = Number(m[3]);
  let months = (cutoffYear - by) * 12 + (cm - bm);
  if (cd < bd) months -= 1;
  return months;
}

type AgeRule = { standardId: string; minMonths: number; maxMonths?: number | null };
export function ageWarning(dob: string | null, standardId: string, rules: unknown, cutoff: string, yearStart: Date): string | null {
  if (!dob) return null;
  const rule = (Array.isArray(rules) ? (rules as AgeRule[]) : []).find(r => r.standardId === standardId);
  if (!rule) return null;
  const months = ageInMonths(dob, yearStart.getUTCFullYear(), cutoff);
  if (months === null) return null;
  if (months < rule.minMonths) return `Under age by ${rule.minMonths - months} month${rule.minMonths - months === 1 ? "" : "s"}`;
  if (rule.maxMonths != null && months > rule.maxMonths) return `Over age by ${months - rule.maxMonths} month${months - rule.maxMonths === 1 ? "" : "s"}`;
  return null;
}

// ── Loading one application ─────────────────────────────────────────────────
export async function loadApplication(institutionId: string, id: string) {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError("Application not found");
  const app = await academicDb().admissionApplication.findFirst({ where: { id, institutionId } });
  if (!app) throw new NotFoundError("Application not found");
  return app;
}

export function assertRevision(current: number, sent: number) {
  if (current !== sent) throw new ConflictError("Someone else changed this application. Refresh and try again.");
}

export async function assertStandard(institutionId: string, standardId: string) {
  const s = await academicDb().standard.findFirst({ where: { id: standardId, institutionId }, select: { id: true, name: true } });
  if (!s) throw new BadRequestError("That class does not exist");
  return s;
}

export type DocTick = { id: string; name: string; seen: boolean; seenAt?: string; seenBy?: string; note?: string };
export function docsPending(settingsDocs: unknown, ticks: unknown) {
  const list = Array.isArray(settingsDocs) ? (settingsDocs as { id: string; name: string; required: boolean }[]) : [];
  const done = new Set((Array.isArray(ticks) ? (ticks as DocTick[]) : []).filter(t => t.seen).map(t => t.id));
  return list.filter(d => d.required && !done.has(d.id)).map(d => d.name);
}

export const feePaid = (fee: unknown) => !!fee && typeof fee === "object" && ["PAID", "WAIVED"].includes((fee as { status?: string }).status ?? "");
