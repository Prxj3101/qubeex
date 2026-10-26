import { z } from "zod";
import { encryptField, decryptFieldSafe } from "../../services/fieldEncryption.service";
import type { Details } from "./admissions.shared";

// ── Admission form (the school's full form, filled after selection) ─────────
// The school designs it once in settings (sections, fields, declaration,
// signature lines). Parents fill it online, or the school keeps paper forms
// (offline) and only ticks "received". Values are stored encrypted on the
// application; nothing is uploaded.

export const FORM_FIELD_TYPES = ["text", "textarea", "date", "number", "select", "checkbox"] as const;

/** Where a field is filled from, so parents do not type the same thing twice. */
export const FORM_SOURCES = [
  "childName", "dob", "gender", "className", "fatherName", "motherName", "guardianName", "phone", "altPhone", "email",
  "address", "city", "pincode", "bloodGroup", "previousSchool", "sibling", "transport", "religion", "category", "motherTongue",
] as const;
export type FormSource = typeof FORM_SOURCES[number];

const fieldSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  type: z.enum(FORM_FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  required: z.boolean().default(false),
  source: z.enum(FORM_SOURCES).nullable().optional(),
});
const sectionSchema = z.object({
  id: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(80),
  fields: z.array(fieldSchema).max(40),
});

// The school's own form, uploaded once as a PDF (or photos of the pages). It
// is never changed: answers are printed on top at the marked boxes. Box
// positions are fractions of the page (0-1), so they fit any print size.
//   text - a line or empty space;  comb - one letter (or date digit) per cell;
//   tick - a mark printed when the answer equals this box's option.
export const SPECIAL_BOXES = ["_applicationNo", "_admissionNo", "_session", "_today"] as const;
const boxSchema = z.object({
  id: z.string().trim().min(1).max(40),
  page: z.number().int().min(0).max(19),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  w: z.number().min(0.003).max(1), h: z.number().min(0.003).max(1),
  fieldId: z.string().trim().min(1).max(40),
  kind: z.enum(["text", "comb", "tick"]).default("text"),
  cells: z.number().int().min(1).max(80).optional(),
  option: z.string().trim().max(60).optional(),
  upper: z.boolean().default(false),
  size: z.number().min(5).max(28).default(10),
  /** Print only one word of a name: first, middle or last. */
  part: z.enum(["first", "middle", "last"]).optional(),
  /** The next line of the answer in the box before it (same question): long answers run on. */
  next: z.boolean().optional(),
});
const templateSchema = z.object({
  kind: z.enum(["QUBEEX", "UPLOAD"]).default("QUBEEX"),
  pages: z.array(z.object({
    url: z.string().url().max(600),
    type: z.enum(["pdf", "image"]),
    pdfPage: z.number().int().min(0).max(49).default(0),
    width: z.number().min(50).max(20000), height: z.number().min(50).max(20000),
  })).max(20).default([]),
  boxes: z.array(boxSchema).max(600).default([]),
});
export type FormTemplate = z.infer<typeof templateSchema>;

export const admissionFormSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["ONLINE", "OFFLINE"]).default("ONLINE"),
  requiredForAdmit: z.boolean().default(true),
  title: z.string().trim().min(1).max(80).default("Admission Form"),
  sections: z.array(sectionSchema).max(12),
  declaration: z.string().trim().max(1500).default(""),
  signatures: z.array(z.string().trim().min(1).max(40)).max(4).default([]),
  photoBox: z.boolean().default(true),
  template: templateSchema.default({ kind: "QUBEEX", pages: [], boxes: [] }),
});
export type AdmissionFormConfig = z.infer<typeof admissionFormSchema>;
export type FormField = AdmissionFormConfig["sections"][number]["fields"][number];

const f = (id: string, label: string, type: FormField["type"], extra: Partial<FormField> = {}): FormField =>
  ({ id, label, type, options: [], required: false, ...extra });

/** A sensible Indian school admission form to start from. Schools edit it. */
export const DEFAULT_ADMISSION_FORM: AdmissionFormConfig = {
  enabled: false,
  mode: "ONLINE",
  requiredForAdmit: true,
  title: "Admission Form",
  photoBox: true,
  template: { kind: "QUBEEX", pages: [], boxes: [] },
  sections: [
    { id: "child", title: "Details of the child", fields: [
      f("childName", "Full name of the child", "text", { required: true, source: "childName" }),
      f("dob", "Date of birth", "date", { required: true, source: "dob" }),
      f("gender", "Gender", "select", { options: ["Boy", "Girl", "Other"], required: true, source: "gender" }),
      f("className", "Class applying for", "text", { source: "className" }),
      f("bloodGroup", "Blood group", "text", { source: "bloodGroup" }),
      f("motherTongue", "Mother tongue", "text", { source: "motherTongue" }),
      f("religion", "Religion", "text", { source: "religion" }),
      f("category", "Category", "select", { options: ["General", "OBC", "SC", "ST", "EWS", "Other"], source: "category" }),
      f("childId", "Aadhaar / APAAR ID of the child", "text"),
    ] },
    { id: "father", title: "Father's details", fields: [
      f("fatherName", "Father's name", "text", { required: true, source: "fatherName" }),
      f("fatherOccupation", "Occupation", "text"),
      f("fatherQualification", "Qualification", "text"),
      f("fatherPhone", "Mobile number", "text", { source: "phone" }),
      f("fatherEmail", "Email", "text", { source: "email" }),
    ] },
    { id: "mother", title: "Mother's details", fields: [
      f("motherName", "Mother's name", "text", { required: true, source: "motherName" }),
      f("motherOccupation", "Occupation", "text"),
      f("motherQualification", "Qualification", "text"),
      f("motherPhone", "Mobile number", "text", { source: "altPhone" }),
    ] },
    { id: "address", title: "Address", fields: [
      f("address", "Residential address", "textarea", { required: true, source: "address" }),
      f("city", "City", "text", { source: "city" }),
      f("pincode", "PIN code", "text", { source: "pincode" }),
    ] },
    { id: "previous", title: "Previous school", fields: [
      f("previousSchool", "Name of the previous school", "text", { source: "previousSchool" }),
      f("lastClass", "Last class passed", "text"),
      f("tcNumber", "Transfer Certificate number", "text"),
    ] },
    { id: "health", title: "Health and emergency", fields: [
      f("medical", "Allergies or medical conditions", "textarea"),
      f("emergencyName", "Emergency contact name", "text", { required: true }),
      f("emergencyPhone", "Emergency contact number", "text", { required: true }),
    ] },
    { id: "other", title: "Other", fields: [
      f("transport", "School transport needed (pickup area)", "text", { source: "transport" }),
      f("sibling", "Brother or sister in this school", "text", { source: "sibling" }),
    ] },
  ],
  declaration: "I declare that the details given above are true. I agree to follow the rules of the school and to pay the fees on time.",
  signatures: ["Father / Guardian", "Mother", "Principal"],
};

/** The school's form settings, or the default form when not set up yet. */
export function readAdmissionForm(raw: unknown): AdmissionFormConfig {
  const parsed = admissionFormSchema.safeParse(raw);
  if (parsed.success && parsed.data.sections.length) return parsed.data;
  const base = raw && typeof raw === "object" ? raw as Partial<AdmissionFormConfig> : {};
  return { ...DEFAULT_ADMISSION_FORM, ...(typeof base.enabled === "boolean" ? { enabled: base.enabled } : {}), ...(base.mode ? { mode: base.mode } : {}) };
}

export type FormValues = Record<string, string | boolean>;

/** Values a field would get from what the parent already gave at registration. */
export function prefillValues(cfg: AdmissionFormConfig, child: { childName: string; dob: string | null; gender: string | null; className: string }, d: Details): FormValues {
  const g = child.gender === "Male" ? "Boy" : child.gender === "Female" ? "Girl" : child.gender === "Other" ? "Other" : "";
  const from: Record<FormSource, string> = {
    childName: child.childName, dob: child.dob ?? "", gender: g, className: child.className,
    fatherName: d.fatherName, motherName: d.motherName, guardianName: d.guardianName, phone: d.phone, altPhone: d.altPhone, email: d.email,
    address: d.address, city: d.city, pincode: d.pincode, bloodGroup: d.bloodGroup, previousSchool: d.previousSchool,
    sibling: d.sibling, transport: d.transport, religion: d.religion, category: d.category, motherTongue: d.motherTongue,
  };
  const out: FormValues = {};
  for (const s of cfg.sections) for (const fl of s.fields) if (fl.source && from[fl.source]) out[fl.id] = from[fl.source];
  return out;
}

/** Keeps only known fields, trims text, and (when asked) checks required ones. */
export function cleanValues(cfg: AdmissionFormConfig, input: unknown, checkRequired: boolean): { values: FormValues; missing: string[] } {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const values: FormValues = {};
  const missing: string[] = [];
  for (const s of cfg.sections) for (const fl of s.fields) {
    const v = raw[fl.id];
    if (fl.type === "checkbox") values[fl.id] = v === true;
    else if (typeof v === "string" && v.trim()) values[fl.id] = v.trim().slice(0, fl.type === "textarea" ? 1000 : 300);
    if (checkRequired && fl.required && (fl.type === "checkbox" ? values[fl.id] !== true : !values[fl.id])) missing.push(fl.label);
  }
  return { values, missing };
}

export type FormRecord = { status: "FILLED" | "RECEIVED"; values?: string; at: string; by: string };

export const encryptValues = (v: FormValues) => encryptField(JSON.stringify(v));
export function decryptValues(packed: string | undefined): FormValues {
  if (!packed) return {};
  try { const v = JSON.parse(decryptFieldSafe(packed) ?? "{}"); return v && typeof v === "object" ? v as FormValues : {}; } catch { return {}; }
}

/** Status for screens: null when the school does not use the admission form. */
export function formState(cfg: AdmissionFormConfig, record: unknown): { status: "PENDING" | "FILLED" | "RECEIVED"; at: string | null; by: string | null } | null {
  if (!cfg.enabled) return null;
  const r = record as FormRecord | null;
  return r?.status ? { status: r.status, at: r.at, by: r.by } : { status: "PENDING", at: null, by: null };
}

/** True when the admission form is done (filled online or received on paper). */
export const formDone = (record: unknown) => !!(record as FormRecord | null)?.status;
