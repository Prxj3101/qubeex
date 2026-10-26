import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../utils/prisma";
import { academicDb, runWithAcademicClient } from "../../utils/academicContext";
import { getAcademicClient } from "../../services/tenantDb.service";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import {
  DEFAULT_FIELDS, detailsSchema, childSchema, encryptDetails, parentLabel, last4, newToken, withEvent,
  getSettings, targetYear, nextApplicationNo, ageWarning, lastNote,
} from "./admissions.shared";
import { lapseOverdueOffers, notifyParent } from "./admissions.place";
import { cleanValues, decryptValues, encryptValues, formState, prefillValues, readAdmissionForm } from "./admissions.form";
import { decryptDetails } from "./admissions.shared";

// Public, logged-out pages for parents: the school's registration form and the
// status page reached from the emailed link. The school is found by its
// institution code; everything else then runs against that school's database.
const router = Router();
const isDev = process.env.NODE_ENV !== "production";
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: isDev ? 50 : 5, standardHeaders: true, legacyHeaders: false, validate: { default: false },
  message: { success: false, message: "Too many forms sent from this device. Please try again in a few minutes." },
});
const readLimiter = rateLimit({ windowMs: 60 * 1000, max: isDev ? 300 : 60, standardHeaders: true, legacyHeaders: false, validate: { default: false } });

async function withSchool<T>(code: string, fn: (school: { id: string; name: string; logoUrl: string | null; institutionCode: string }) => Promise<T>) {
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(code)) throw new NotFoundError("School not found");
  const school = await prisma.institution.findUnique({ where: { institutionCode: code }, select: { id: true, name: true, logoUrl: true, institutionCode: true, status: true } });
  if (!school || school.status !== "ACTIVE") throw new NotFoundError("School not found");
  const client = await getAcademicClient(school.id);
  return runWithAcademicClient(client, () => fn(school));
}

const publicStage = (stage: string, outcome: string | null) => {
  if (outcome === "WAITLIST") return "Waitlist";
  if (outcome === "NOT_SELECTED") return "Not selected";
  if (outcome === "WITHDRAWN") return "Withdrawn";
  if (outcome === "LAPSED") return "Offer expired";
  return ({ ENQUIRY: "Enquiry noted", REGISTERED: "Registered", INTERACTION: "Interaction", SELECTED: "Selected", ADMITTED: "Admitted" } as Record<string, string>)[stage] ?? stage;
};

router.get("/:code", readLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await withSchool(req.params.code as string, async school => {
      const settings = await getSettings(school.id);
      const year = await targetYear(school.id, settings.academicYearId);
      const standards = await academicDb().standard.findMany({ where: { institutionId: school.id }, orderBy: { order: "asc" }, select: { id: true, name: true } });
      return {
        school: { name: school.name, logoUrl: school.logoUrl }, open: settings.formOpen, session: year.label,
        classes: standards, fields: { ...DEFAULT_FIELDS, ...(settings.fields as object) }, questions: settings.questions,
        documents: settings.documents, registrationFee: settings.registrationFee == null ? null : Number(settings.registrationFee),
      };
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

const submitSchema = childSchema.extend({
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date of birth"),
  details: detailsSchema.extend({ email: z.string().trim().toLowerCase().email("Enter a valid email").max(160) }),
  consent: z.literal(true, { message: "Please confirm the declaration" }),
  website: z.string().max(0).optional(), // honeypot: real parents never fill this
}).strict();

router.post("/:code/applications", submitLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = submitSchema.parse(req.body);
    const data = await withSchool(req.params.code as string, async school => {
      const settings = await getSettings(school.id);
      if (!settings.formOpen) throw new BadRequestError("Admissions are closed right now. Please contact the school.");
      const std = await academicDb().standard.findFirst({ where: { id: input.standardId, institutionId: school.id }, select: { id: true } });
      if (!std) throw new BadRequestError("Pick a class");
      const questions = (Array.isArray(settings.questions) ? settings.questions : []) as { id: string; label: string; required: boolean }[];
      for (const q of questions) if (q.required && !input.details.answers[q.id]?.trim()) throw new BadRequestError(`Please answer: ${q.label}`);
      const year = await targetYear(school.id, settings.academicYearId);
      const app = await academicDb().admissionApplication.create({ data: {
        institutionId: school.id, academicYearId: year.id, applicationNo: await nextApplicationNo(school.id, year.label),
        standardId: input.standardId, stage: "REGISTERED", source: "ONLINE",
        childName: input.childName, dob: input.dob, gender: input.gender ?? null,
        parentName: parentLabel(input.details), phoneLast4: last4(input.details.phone), details: encryptDetails(input.details),
        statusToken: newToken(), events: withEvent([], "REGISTERED", "Parent", `Online form, consent given ${new Date().toISOString()}`),
      } });
      await notifyParent(school.id, app.id, { kind: "RECEIVED" }).catch(() => {});
      return { applicationNo: app.applicationNo, statusToken: app.statusToken, ageWarning: ageWarning(input.dob, input.standardId, settings.ageRules, settings.ageCutoff, year.startDate) };
    });
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
});

router.get("/:code/status/:token", readLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/).safeParse(req.params.token);
    if (!token.success) throw new NotFoundError("Application not found");
    const data = await withSchool(req.params.code as string, async school => {
      await lapseOverdueOffers(school.id);
      const a = await academicDb().admissionApplication.findFirst({ where: { institutionId: school.id, statusToken: token.data } });
      if (!a) throw new NotFoundError("Application not found");
      const [std, settings, year] = await Promise.all([
        academicDb().standard.findFirst({ where: { id: a.standardId, institutionId: school.id }, select: { name: true } }),
        getSettings(school.id),
        academicDb().academicYear.findFirst({ where: { id: a.academicYearId }, select: { label: true } }),
      ]);
      const interaction = a.interaction as { at?: string; doneAt?: string; note?: string } | null;
      const offer = a.offer as { dueOn?: string } | null;
      return {
        school: { name: school.name, logoUrl: school.logoUrl }, applicationNo: a.applicationNo, childName: a.childName,
        className: std?.name ?? "", session: year?.label ?? "", status: publicStage(a.stage, a.outcome), stage: a.stage, outcome: a.outcome,
        interactionStep: settings.interactionStep,
        waitlistRank: a.outcome === "WAITLIST" ? a.waitlistRank : null,
        interactionAt: interaction?.at && !interaction.doneAt ? interaction.at : null,
        interactionNote: interaction?.at && !interaction.doneAt ? interaction.note?.trim() || null : null,
        interactionDone: !!interaction?.doneAt,
        closedReason: a.outcome === "NOT_SELECTED" ? lastNote(a.events, "NOT_SELECTED") ?? null : null,
        // Online admission form: shown once selected, until the child is placed.
        admissionForm: (() => {
          const cfg = readAdmissionForm(settings.admissionForm);
          const state = formState(cfg, a.admissionForm);
          const open = !a.outcome && (a.stage === "SELECTED" || (a.stage === "ADMITTED" && !a.studentId));
          return state && cfg.mode === "ONLINE" && open ? { status: state.status, title: cfg.title } : null;
        })(),
        // The admission form as a step of the journey (online or paper).
        formStep: (() => {
          const cfg = readAdmissionForm(settings.admissionForm);
          if (!cfg.enabled) return null;
          const status = ((a.admissionForm as { status?: string } | null)?.status ?? "PENDING") as "PENDING" | "FILLED" | "RECEIVED";
          const open = !a.outcome && (a.stage === "SELECTED" || (a.stage === "ADMITTED" && !a.studentId));
          return { mode: cfg.mode, status, required: cfg.requiredForAdmit, open, title: cfg.title };
        })(),
        feeDueOn: a.stage === "SELECTED" && !a.outcome && !(a.admissionFee as { status?: string } | null)?.status ? offer?.dueOn ?? null : null,
        admissionNo: a.stage === "ADMITTED" ? a.admissionNo : null,
        documentsToBring: a.stage === "SELECTED" && !a.outcome ? ((Array.isArray(settings.documents) ? settings.documents : []) as { name: string; required: boolean }[]).map(d => ({ name: d.name, required: d.required })) : [],
        // What the parent saw right after sending the form, so they can open it again any time.
        receipt: {
          submittedAt: a.createdAt.toISOString(),
          registrationFee: settings.registrationFee == null ? null : Number(settings.registrationFee),
          documents: ((Array.isArray(settings.documents) ? settings.documents : []) as { name: string; required: boolean }[]).map(d => ({ name: d.name, required: d.required })),
        },
      };
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── Admission form (online), from the link in the offer email ───────────────
async function loadForForm(schoolId: string, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundError("Application not found");
  const a = await academicDb().admissionApplication.findFirst({ where: { institutionId: schoolId, statusToken: token } });
  if (!a) throw new NotFoundError("Application not found");
  const settings = await getSettings(schoolId);
  const cfg = readAdmissionForm(settings.admissionForm);
  const open = cfg.enabled && cfg.mode === "ONLINE" && !a.outcome && (a.stage === "SELECTED" || (a.stage === "ADMITTED" && !a.studentId));
  return { a, cfg, open };
}

router.get("/:code/admission-form/:token", readLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await withSchool(req.params.code as string, async school => {
      const { a, cfg, open } = await loadForForm(school.id, req.params.token as string);
      const [std, year] = await Promise.all([
        academicDb().standard.findFirst({ where: { id: a.standardId, institutionId: school.id }, select: { name: true } }),
        academicDb().academicYear.findFirst({ where: { id: a.academicYearId }, select: { label: true } }),
      ]);
      const record = a.admissionForm as { status?: string; at?: string; values?: string } | null;
      const values = { ...prefillValues(cfg, { childName: a.childName, dob: a.dob, gender: a.gender, className: std?.name ?? "" }, decryptDetails(a.details)), ...decryptValues(record?.values) };
      // What the printed form looks like, so the parent can see it filled before sending.
      const inst = open ? await prisma.institution.findUnique({ where: { id: school.id }, select: { address: true, city: true, phone: true, email: true } }) : null;
      const today = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" });
      return {
        school: { name: school.name, logoUrl: school.logoUrl }, open, applicationNo: a.applicationNo, childName: a.childName,
        className: std?.name ?? "", session: year?.label ?? "", status: record?.status ?? null, filledAt: record?.at ?? null,
        form: open ? { title: cfg.title, sections: cfg.sections, declaration: cfg.declaration } : null,
        values: open ? values : {},
        print: open ? {
          school: { name: school.name, logoUrl: school.logoUrl, address: [inst?.address, inst?.city].filter(Boolean).join(", "), phone: inst?.phone ?? "", email: inst?.email ?? "" },
          session: year?.label ?? "",
          config: cfg,
          application: { applicationNo: a.applicationNo, admissionNo: a.admissionNo, childName: a.childName, className: std?.name ?? "" },
          values: { _applicationNo: a.applicationNo, _admissionNo: a.admissionNo ?? "", _session: year?.label ?? "", _today: today },
        } : null,
      };
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post("/:code/admission-form/:token", submitLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    z.object({ consent: z.literal(true, { message: "Please confirm the declaration" }) }).parse({ consent: req.body?.consent });
    await withSchool(req.params.code as string, async school => {
      const { a, cfg, open } = await loadForForm(school.id, req.params.token as string);
      if (!open) throw new BadRequestError("This admission form is not open. Please contact the school office.");
      const { values, missing } = cleanValues(cfg, req.body?.values, true);
      if (missing.length) throw new BadRequestError(`Please fill: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}`);
      const done = await academicDb().admissionApplication.updateMany({
        where: { id: a.id, revision: a.revision },
        data: {
          admissionForm: { status: "FILLED", values: encryptValues(values), at: new Date().toISOString(), by: "Parent" },
          revision: { increment: 1 },
          events: withEvent(a.events, "ADMISSION_FORM", "Parent", `Filled online, consent given ${new Date().toISOString()}`),
        },
      });
      if (done.count !== 1) throw new BadRequestError("Please refresh the page and send again.");
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
