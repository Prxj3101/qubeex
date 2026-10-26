import { Router, Response, NextFunction, raw } from "express";
import { z } from "zod";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { requirePermission } from "../../middlewares/requirePermission.middleware";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { BadRequestError, ConflictError } from "../../utils/errors";
import { resolveUsers } from "../../services/userLookup.service";
import { logAudit } from "../../services/audit.service";
import type { Prisma } from "../../generated/prisma/client";
import {
  SOURCES, DEFAULT_FIELDS, settingsSchema, detailsSchema, childSchema, encryptDetails, decryptDetails, parentLabel, last4,
  newToken, withEvent, getSettings, targetYear, sessionChoices, nextApplicationNo, takeAdmissionNo, ageWarning, loadApplication,
  assertRevision, assertStandard, docsPending, feePaid, isPastSession, assertOpenSession, sectionLabel, type DocTick, type Stage,
} from "./admissions.shared";
import { lapseOverdueOffers, notifyParent, placeApplication, resendParentEmail, todayIST } from "./admissions.place";
import { cleanValues, decryptValues, encryptValues, formDone, formState, prefillValues, readAdmissionForm, SPECIAL_BOXES } from "./admissions.form";
import { uploadAttachmentToR2, uploadImageToR2 } from "../../services/storage.service";
import { recordAiUsage } from "../../services/ai-usage.service";
import { TooManyRequestsError } from "../../utils/errors";

const router = Router();
router.use(authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware, requirePermission("ADMISSIONS"));

const institutionOf = (req: AuthRequest) => {
  if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account");
  return req.user.institutionId;
};
async function actorName(req: AuthRequest) {
  const map = await resolveUsers([req.user!.userId], { id: true, name: true });
  return map.get(req.user!.userId)?.name || "Office";
}
const json = (value: unknown) => value as Prisma.InputJsonValue;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function serializeSettings(s: Awaited<ReturnType<typeof getSettings>>) {
  return {
    academicYearId: s.academicYearId, formOpen: s.formOpen, interactionStep: s.interactionStep,
    registrationFee: s.registrationFee == null ? null : Number(s.registrationFee), admissionFeeDays: s.admissionFeeDays,
    ageCutoff: s.ageCutoff, ageRules: s.ageRules, fields: { ...DEFAULT_FIELDS, ...(s.fields as object) }, questions: s.questions,
    documents: s.documents, admissionNoPrefix: s.admissionNoPrefix, nextAdmissionNo: s.nextAdmissionNo, revision: s.revision,
    admissionForm: readAdmissionForm(s.admissionForm),
  };
}

async function standardsWithSections(institutionId: string) {
  const standards = await academicDb().standard.findMany({
    where: { institutionId }, orderBy: { order: "asc" },
    select: { id: true, name: true, divisions: { select: { id: true, name: true }, orderBy: { name: "asc" } } },
  });
  return standards;
}

// ── Settings ────────────────────────────────────────────────────────────────
/**
 * The school's logo, served from here so the share poster can draw it on a
 * canvas (the storage bucket does not send CORS headers). Only ever fetches
 * the institution's own saved logo URL.
 */
router.get("/logo", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institution = await prisma.institution.findUnique({ where: { id: institutionOf(req) }, select: { logoUrl: true } });
    if (!institution?.logoUrl) { res.status(204).end(); return; }
    const upstream = await fetch(institution.logoUrl, { signal: AbortSignal.timeout(8000) });
    const type = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !type.startsWith("image/")) { res.status(204).end(); return; }
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > 5 * 1024 * 1024) { res.status(204).end(); return; }
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "private, max-age=600");
    res.send(body);
  } catch (err) { next(err); }
});

router.get("/settings", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const settings = await getSettings(institutionId);
    const [sessions, standards, institution, year] = await Promise.all([
      sessionChoices(institutionId),
      standardsWithSections(institutionId),
      prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true, institutionCode: true, logoUrl: true } }),
      targetYear(institutionId, settings.academicYearId),
    ]);
    res.json({ success: true, data: {
      settings: serializeSettings(settings), sessions, standards,
      session: { id: year.id, label: year.label, isCurrent: year.isCurrent },
      school: { name: institution?.name ?? "", formCode: institution?.institutionCode ?? "", logoUrl: institution?.logoUrl ?? null },
    } });
  } catch (err) { next(err); }
});

router.put("/settings", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const input = settingsSchema.parse(req.body);
    const current = await getSettings(institutionId);
    assertRevision(current.revision, input.revision);
    if (input.academicYearId) {
      const allowed = (await sessionChoices(institutionId)).some(s => s.id === input.academicYearId);
      if (!allowed) throw new BadRequestError("Pick the current or the next session");
    }
    if (input.ageRules) for (const r of input.ageRules) await assertStandard(institutionId, r.standardId);
    if (input.documents && new Set(input.documents.map(d => d.id)).size !== input.documents.length) throw new BadRequestError("Two documents have the same id");
    if (input.questions && new Set(input.questions.map(q => q.id)).size !== input.questions.length) throw new BadRequestError("Two questions have the same id");
    if (input.admissionForm) {
      const ids = input.admissionForm.sections.flatMap(s => s.fields.map(f => f.id));
      if (new Set(ids).size !== ids.length) throw new BadRequestError("Two admission form fields have the same id");
      if (!input.admissionForm.sections.length) throw new BadRequestError("The admission form needs at least one section");
      const t = input.admissionForm.template;
      // Uploaded pages must be our own stored images, never any outside link.
      const base = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
      if (t.pages.some(p => !base || !p.url.startsWith(`${base}/`))) throw new BadRequestError("Upload the form pages again");
      const known = new Set<string>([...ids, ...SPECIAL_BOXES]);
      if (t.boxes.some(b => !known.has(b.fieldId) || b.page >= t.pages.length)) throw new BadRequestError("A marked box points to a field that no longer exists");
    }
    const { revision, ...rest } = input;
    const result = await academicDb().admissionSettings.updateMany({
      where: { institutionId, revision },
      data: {
        ...rest,
        ...(rest.ageRules ? { ageRules: json(rest.ageRules) } : {}),
        ...(rest.fields ? { fields: json({ ...DEFAULT_FIELDS, ...(current.fields as object), ...rest.fields }) } : {}),
        ...(rest.questions ? { questions: json(rest.questions) } : {}),
        ...(rest.documents ? { documents: json(rest.documents) } : {}),
        ...(rest.admissionForm ? { admissionForm: json(rest.admissionForm) } : {}),
        revision: { increment: 1 },
      },
    });
    if (result.count !== 1) throw new ConflictError("Settings were changed by someone else. Refresh and try again.");
    res.json({ success: true, data: serializeSettings(await getSettings(institutionId)) });
  } catch (err) { next(err); }
});

// ── Board ───────────────────────────────────────────────────────────────────
router.get("/applications", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    await lapseOverdueOffers(institutionId);
    const settings = await getSettings(institutionId);
    const asked = typeof req.query.academicYearId === "string" && z.string().uuid().safeParse(req.query.academicYearId).success ? req.query.academicYearId : null;
    const askedYear = asked ? await academicDb().academicYear.findFirst({ where: { id: asked, institutionId } }) : null;
    if (asked && !askedYear) throw new BadRequestError("That session does not exist");
    const year = askedYear ?? await targetYear(institutionId, settings.academicYearId);
    const readOnly = await isPastSession(institutionId, year.id);
    const view = req.query.view === "closed" ? "closed" : "open";
    const standardId = typeof req.query.standardId === "string" && req.query.standardId ? req.query.standardId : undefined;
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 80) : "";
    const closedOutcomes = ["NOT_SELECTED", "WITHDRAWN", "LAPSED"];
    const where: Prisma.AdmissionApplicationWhereInput = {
      institutionId, academicYearId: year.id,
      ...(standardId ? { standardId } : {}),
      ...(view === "closed" ? { outcome: { in: closedOutcomes } } : { OR: [{ outcome: null }, { outcome: "WAITLIST" }] }),
      ...(search ? { AND: [{ OR: [
        { childName: { contains: search, mode: "insensitive" } },
        { parentName: { contains: search, mode: "insensitive" } },
        { applicationNo: { contains: search, mode: "insensitive" } },
        { admissionNo: { contains: search, mode: "insensitive" } },
        ...(/^\d{4}$/.test(search) ? [{ phoneLast4: search }] : []),
      ] }] } : {}),
    };
    const [rows, standards, admittedCounts] = await Promise.all([
      academicDb().admissionApplication.findMany({ where, orderBy: [{ waitlistRank: "asc" }, { updatedAt: "desc" }], take: 1000 }),
      standardsWithSections(institutionId),
      academicDb().admissionApplication.groupBy({ by: ["standardId"], where: { institutionId, academicYearId: year.id, stage: "ADMITTED", outcome: null }, _count: { _all: true } }),
    ]);
    const stdName = new Map(standards.map(s => [s.id, s.name]));
    const divName = new Map(standards.flatMap(s => s.divisions.map(d => [d.id, sectionLabel(s.name, d.name)] as const)));
    const now = today();
    const formCfg = readAdmissionForm(settings.admissionForm);
    // Real photo once the child is a student and the school has added one.
    const studentIds = rows.map(a => a.studentId).filter((id): id is string => !!id);
    const photos = studentIds.length
      ? new Map((await academicDb().student.findMany({ where: { id: { in: studentIds }, institutionId }, select: { id: true, avatarUrl: true } })).map(st => [st.id, st.avatarUrl]))
      : new Map<string, string | null>();
    const data = rows.map(a => {
      const offer = a.offer as { dueOn?: string } | null;
      const interaction = a.interaction as { at?: string; doneAt?: string } | null;
      const pending = docsPending(settings.documents, a.documents);
      return {
        id: a.id, applicationNo: a.applicationNo, revision: a.revision, childName: a.childName, parentName: a.parentName, phoneLast4: a.phoneLast4,
        gender: a.gender, photoUrl: a.studentId ? photos.get(a.studentId) ?? null : null,
        standardId: a.standardId, standardName: stdName.get(a.standardId) ?? "Class removed", stage: a.stage, outcome: a.outcome,
        waitlistRank: a.waitlistRank, source: a.source, createdAt: a.createdAt, updatedAt: a.updatedAt,
        ageWarning: ageWarning(a.dob, a.standardId, settings.ageRules, settings.ageCutoff, year.startDate),
        registrationFeePaid: feePaid(a.registrationFee), admissionFeePaid: feePaid(a.admissionFee),
        registrationFeeDue: settings.registrationFee != null && Number(settings.registrationFee) > 0 && !feePaid(a.registrationFee) && a.stage !== "ENQUIRY" && a.stage !== "ADMITTED",
        offerDueOn: offer?.dueOn ?? null, offerOverdue: !!offer?.dueOn && offer.dueOn < now && !feePaid(a.admissionFee) && a.stage === "SELECTED" && !a.outcome,
        interactionAt: interaction?.at ?? null, interactionDone: !!interaction?.doneAt,
        admissionFormPending: formCfg.enabled && !a.outcome && (a.stage === "SELECTED" || (a.stage === "ADMITTED" && !a.studentId)) && !formDone(a.admissionForm),
        docsPending: pending.length, admissionNo: a.admissionNo, sectionName: a.divisionId ? divName.get(a.divisionId) ?? null : null, placed: !!a.studentId,
      };
    });
    res.json({ success: true, data, session: { id: year.id, label: year.label, isCurrent: year.isCurrent, readOnly },
      admitted: admittedCounts.map(c => ({ standardId: c.standardId, standardName: stdName.get(c.standardId) ?? "", count: c._count._all })) });
  } catch (err) { next(err); }
});

// ── Create (counter, phone enquiry) ────────────────────────────────────────
const createSchema = childSchema.extend({
  stage: z.enum(["ENQUIRY", "REGISTERED"]),
  source: z.enum(SOURCES).default("COUNTER"),
  details: detailsSchema,
}).strict();

router.post("/applications", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const input = createSchema.parse(req.body);
    await assertStandard(institutionId, input.standardId);
    if (!input.dob) throw new BadRequestError("Enter the date of birth");
    const settings = await getSettings(institutionId);
    const year = await targetYear(institutionId, settings.academicYearId);
    const by = await actorName(req);
    const app = await academicDb().admissionApplication.create({ data: {
      institutionId, academicYearId: year.id, applicationNo: await nextApplicationNo(institutionId, year.label),
      standardId: input.standardId, stage: input.stage, source: input.source,
      childName: input.childName, dob: input.dob ?? null, gender: input.gender ?? null,
      parentName: parentLabel(input.details), phoneLast4: last4(input.details.phone), details: encryptDetails(input.details),
      statusToken: newToken(), createdById: req.user!.userId,
      events: withEvent([], input.stage === "ENQUIRY" ? "ENQUIRY_ADDED" : "REGISTERED", by, input.source === "PHONE" ? "Phone call" : "At the counter"),
    } });
    res.status(201).json({ success: true, data: { id: app.id } });
  } catch (err) { next(err); }
});

// ── One application ─────────────────────────────────────────────────────────
router.get("/applications/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const a = await loadApplication(institutionId, req.params.id as string);
    const settings = await getSettings(institutionId);
    const [standards, year, institution] = await Promise.all([
      standardsWithSections(institutionId),
      academicDb().academicYear.findFirst({ where: { id: a.academicYearId, institutionId } }),
      prisma.institution.findUnique({ where: { id: institutionId }, select: { institutionCode: true, name: true } }),
    ]);
    const std = standards.find(s => s.id === a.standardId);
    const ticks = (Array.isArray(a.documents) ? a.documents : []) as DocTick[];
    const docList = (Array.isArray(settings.documents) ? settings.documents : []) as { id: string; name: string; required: boolean }[];
    const documents = [
      ...docList.map(d => ({ ...d, ...(ticks.find(t => t.id === d.id) ?? { seen: false }) , name: d.name, required: d.required })),
      ...ticks.filter(t => !docList.some(d => d.id === t.id) && t.seen).map(t => ({ ...t, required: false })),
    ];
    const student = a.studentId ? await academicDb().student.findFirst({ where: { id: a.studentId, institutionId }, select: { studentId: true, tempPassword: true } }) : null;
    res.json({ success: true, data: {
      id: a.id, applicationNo: a.applicationNo, revision: a.revision, stage: a.stage, outcome: a.outcome, waitlistRank: a.waitlistRank, source: a.source,
      childName: a.childName, dob: a.dob, gender: a.gender, standardId: a.standardId, standardName: std?.name ?? "Class removed",
      sections: std?.divisions ?? [], details: decryptDetails(a.details),
      registrationFee: a.registrationFee, interaction: a.interaction, offer: a.offer, admissionFee: a.admissionFee, documents,
      docsPending: docsPending(settings.documents, a.documents), admissionNo: a.admissionNo, divisionId: a.divisionId,
      placed: !!a.studentId, student: student ? { studentId: student.studentId, tempPassword: student.tempPassword } : null,
      events: a.events, createdAt: a.createdAt,
      session: year ? { id: year.id, label: year.label, isCurrent: year.isCurrent } : null,
      readOnly: await isPastSession(institutionId, a.academicYearId),
      ageWarning: ageWarning(a.dob, a.standardId, settings.ageRules, settings.ageCutoff, year?.startDate ?? new Date()),
      interactionStep: settings.interactionStep, registrationFeeAmount: settings.registrationFee == null ? null : Number(settings.registrationFee),
      nextAdmissionNo: `${settings.admissionNoPrefix}${String(settings.nextAdmissionNo).padStart(4, "0")}`,
      admissionForm: (() => {
        const cfg = readAdmissionForm(settings.admissionForm);
        const state = formState(cfg, a.admissionForm);
        if (!state) return null;
        const details = decryptDetails(a.details);
        const values = { ...prefillValues(cfg, { childName: a.childName, dob: a.dob, gender: a.gender, className: std?.name ?? "" }, details), ...decryptValues((a.admissionForm as { values?: string } | null)?.values) };
        return { config: cfg, ...state, values };
      })(),
      questions: settings.questions, fields: { ...DEFAULT_FIELDS, ...(settings.fields as object) },
      schoolName: institution?.name ?? "",
      statusLink: institution ? `${process.env.FRONTEND_URL ?? ""}/apply/${institution.institutionCode}/status/${a.statusToken}` : null,
    } });
  } catch (err) { next(err); }
});

// Details arrive as a partial object; they are merged over the stored ones and
// only then validated, so a field the form did not send is never reset.
const editSchema = childSchema.partial().extend({ revision: z.number().int().min(1), details: z.record(z.string(), z.unknown()).optional() }).strict();
router.patch("/applications/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const input = editSchema.parse(req.body);
    const a = await loadApplication(institutionId, req.params.id as string);
    await assertOpenSession(institutionId, a.academicYearId);
    assertRevision(a.revision, input.revision);
    if (a.studentId) throw new BadRequestError("This child is already a student. Edit the details from the class instead.");
    if (input.standardId && input.standardId !== a.standardId) {
      await assertStandard(institutionId, input.standardId);
      if (a.stage === "ADMITTED") throw new BadRequestError("The class cannot change after admission");
    }
    const details = input.details ? detailsSchema.parse({ ...decryptDetails(a.details), ...input.details }) : null;
    const by = await actorName(req);
    const result = await academicDb().admissionApplication.updateMany({ where: { id: a.id, institutionId, revision: a.revision }, data: {
      ...(input.childName ? { childName: input.childName } : {}),
      ...(input.dob !== undefined ? { dob: input.dob } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.standardId ? { standardId: input.standardId } : {}),
      ...(details ? { details: encryptDetails(details), parentName: parentLabel(details), phoneLast4: last4(details.phone) } : {}),
      events: withEvent(a.events, "DETAILS_EDITED", by), revision: { increment: 1 },
    } });
    if (result.count !== 1) throw new ConflictError("Someone else changed this application. Refresh and try again.");
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Actions: one endpoint, one button each ─────────────────────────────────
const feeSchema = z.object({ mode: z.enum(["COUNTER", "ONLINE", "WAIVED"]), ref: z.string().trim().max(80).default(""), amount: z.number().min(0).max(10_000_000).nullable().optional() });
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("REGISTER") }),
  z.object({ action: z.literal("REG_FEE") }).merge(feeSchema),
  z.object({ action: z.literal("SCHEDULE"), at: z.string().datetime({ offset: true }), note: z.string().trim().max(300).default("") }),
  z.object({ action: z.literal("INTERACTION_DONE"), remark: z.string().trim().min(1, "Write a short remark").max(1000), result: z.string().trim().max(80).default("") }),
  z.object({ action: z.literal("SELECT"), dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  z.object({ action: z.literal("WAITLIST") }),
  z.object({ action: z.literal("NOT_SELECTED"), reason: z.string().trim().max(300).default("") }),
  z.object({ action: z.literal("WITHDRAW"), reason: z.string().trim().max(300).default("") }),
  z.object({ action: z.literal("LAPSE") }),
  z.object({ action: z.literal("REOPEN") }),
  z.object({ action: z.literal("ADM_FEE") }).merge(feeSchema),
  z.object({ action: z.literal("DOCUMENTS"), items: z.array(z.object({ id: z.string().trim().min(1).max(40), seen: z.boolean(), note: z.string().trim().max(120).default("") })).min(1).max(60) }),
  z.object({ action: z.literal("ADMIT"), admissionNo: z.string().trim().min(1).max(30).optional(), divisionId: z.string().uuid().nullable().optional() }),
  z.object({ action: z.literal("SET_SECTION"), divisionId: z.string().uuid().nullable() }),
]);

// Send the parent the latest email again (if the first one did not arrive).
router.post("/applications/:id/resend-email", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const a = await loadApplication(institutionId, req.params.id as string);
    await assertOpenSession(institutionId, a.academicYearId);
    const result = await resendParentEmail(institutionId, a.id, await actorName(req));
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ── Admission form ──────────────────────────────────────────────────────────
// Office fills or corrects the form (online mode), or ticks that the paper
// form came back (offline mode). Only after the child is selected.
const formOpenFor = (a: { stage: string; outcome: string | null }) => !a.outcome && (a.stage === "SELECTED" || a.stage === "ADMITTED");

router.put("/applications/:id/admission-form", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const revision = z.number().int().min(1).parse(req.body?.revision);
    const a = await loadApplication(institutionId, req.params.id as string);
    await assertOpenSession(institutionId, a.academicYearId);
    assertRevision(a.revision, revision);
    const cfg = readAdmissionForm((await getSettings(institutionId)).admissionForm);
    if (!cfg.enabled) throw new BadRequestError("The admission form is turned off in settings");
    if (!formOpenFor(a)) throw new BadRequestError("The admission form opens after the child is selected");
    const { values, missing } = cleanValues(cfg, req.body?.values, true);
    if (missing.length) throw new BadRequestError(`Fill: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}`);
    const by = await actorName(req);
    const done = await academicDb().admissionApplication.updateMany({
      where: { id: a.id, revision },
      data: { admissionForm: json({ status: "FILLED", values: encryptValues(values), at: new Date().toISOString(), by }), revision: { increment: 1 }, events: withEvent(a.events, "ADMISSION_FORM", by, "Filled by the office") },
    });
    if (done.count !== 1) throw new ConflictError(`${a.childName} was changed by someone else. Refresh and try again.`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post("/applications/:id/admission-form/received", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const revision = z.number().int().min(1).parse(req.body?.revision);
    const received = req.body?.received !== false;
    const a = await loadApplication(institutionId, req.params.id as string);
    await assertOpenSession(institutionId, a.academicYearId);
    assertRevision(a.revision, revision);
    const cfg = readAdmissionForm((await getSettings(institutionId)).admissionForm);
    if (!cfg.enabled) throw new BadRequestError("The admission form is turned off in settings");
    if (!formOpenFor(a)) throw new BadRequestError("The admission form opens after the child is selected");
    const by = await actorName(req);
    const prev = (a.admissionForm ?? {}) as { values?: string };
    const done = await academicDb().admissionApplication.updateMany({
      where: { id: a.id, revision },
      data: {
        admissionForm: received ? json({ status: "RECEIVED", ...(prev.values ? { values: prev.values } : {}), at: new Date().toISOString(), by }) : json(prev.values ? { values: prev.values } : {}),
        revision: { increment: 1 },
        events: withEvent(a.events, "ADMISSION_FORM", by, received ? "Paper form received" : "Marked as not received"),
      },
    });
    if (done.count !== 1) throw new ConflictError(`${a.childName} was changed by someone else. Refresh and try again.`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Data for the printable form: one child (filled), or blank for paper forms.
async function printHeader(institutionId: string, academicYearId?: string) {
  const [institution, settings] = await Promise.all([
    prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true, logoUrl: true, address: true, city: true, phone: true, email: true } }),
    getSettings(institutionId),
  ]);
  const year = academicYearId
    ? await academicDb().academicYear.findFirst({ where: { id: academicYearId, institutionId }, select: { label: true } })
    : await targetYear(institutionId, settings.academicYearId);
  return {
    school: { name: institution?.name ?? "", logoUrl: institution?.logoUrl ?? null, address: [institution?.address, institution?.city].filter(Boolean).join(", "), phone: institution?.phone ?? "", email: institution?.email ?? "" },
    session: year?.label ?? "",
    config: readAdmissionForm(settings.admissionForm),
  };
}

// One page of the school's own form (a scan or a page of their PDF, turned
// into an image in the browser). Stored like the school logo.
router.post("/admission-form/page", raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const file = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const uploaded = await uploadImageToR2(file, { contentType: req.headers["content-type"] ?? "", folder: "admission-forms", ownerId: institutionId });
    res.json({ success: true, data: { url: uploaded.publicUrl } });
  } catch (err) { next(err); }
});

// The school's own form as a PDF (kept as it is; answers are printed on top).
router.post("/admission-form/file", raw({ type: ["application/pdf"], limit: "15mb" }), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const file = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (file.subarray(0, 5).toString() !== "%PDF-") throw new BadRequestError("Upload a PDF file");
    const uploaded = await uploadAttachmentToR2(file, { originalName: "admission-form.pdf", contentType: "application/pdf", institutionId, area: "admission-forms" });
    res.json({ success: true, data: { url: uploaded.publicUrl } });
  } catch (err) { next(err); }
});

// ── AI auto-mark (once per form) ────────────────────────────────────────────
// The browser finds the blanks on a page (lines, tick boxes, rows of letter
// boxes), numbers them on a picture of the page, and sends it here. The AI
// only says which question each number belongs to; positions stay exact.
const OpenAIModule = (process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY) ? require("openai") : null;
const formAi: import("openai").OpenAI | null = OpenAIModule
  ? new OpenAIModule.OpenAI(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : { apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" })
  : null;
const FORM_AI_PROVIDER: "openai" | "groq" = process.env.OPENAI_API_KEY ? "openai" : "groq";
const FORM_AI_MODEL = process.env.FORM_VISION_MODEL || process.env.MAGIC_VISION_MODEL || (process.env.OPENAI_API_KEY ? "gpt-4.1-mini" : "qwen/qwen3.8-27b");

const autoMarkSchema = z.object({
  image: z.string().regex(/^data:image\/(jpeg|png);base64,/).max(4_000_000).optional(),
  strips: z.array(z.string().regex(/^data:image\/(jpeg|png);base64,/).max(3_000_000)).max(4).default([]),
  candidates: z.array(z.object({ n: z.number().int().min(1).max(400), kind: z.enum(["line", "box", "comb"]), cells: z.number().int().min(1).max(80).optional(), text: z.string().max(120).optional(), after: z.string().max(60).optional(), under: z.string().max(100).optional() })).min(1).max(400),
  fields: z.array(z.object({ id: z.string().max(40), label: z.string().max(120), type: z.string().max(20), options: z.array(z.string().max(60)).max(20).default([]) })).max(300),
}).strict();
const autoMarkReply = z.object({ items: z.array(z.object({
  n: z.number().int(), field: z.string().max(40).nullable().optional(), label: z.string().max(120).nullable().optional(),
  option: z.string().max(60).nullable().optional(), skip: z.boolean().optional(),
  part: z.enum(["first", "middle", "last"]).nullable().optional(),
  next: z.boolean().nullable().optional(),
})).max(400) });

const AUTO_MARK_PROMPT = `You name the blanks on one page of a school's printed admission form. Each blank has a number and is a line or space to write on ("line"), a small tick box ("box"), or a row of letter boxes ("comb").
For each blank you may get:
- "printed": the exact words printed just before it on the same line (read from the file). When given, these ARE its question: trust them.
- "after": words printed just after a tick box (its choice, e.g. "Male").
- "under": the nearest heading above it (e.g. "Mother's details"), to tell whose question it is.
Pictures, when given: the first is the whole page with each blank in a red box, its number in a small red tag inside at the left end. The next ones show every blank cut out with its own line, one strip per blank, the number in the red band on the left: read each blank's question from ITS OWN strip (the words just before the red box). Use the whole page only to see which block it is in.
Without "printed" words or a strip, use the words on the same line just to the left; only if there are none, the words directly above. Never use the question of another line.
- If it means the same as one of the KNOWN fields, give that field id in "field" (mind the person: Father's or Mother's).
- Otherwise give a short clear question in "label" (e.g. "Social category", "Father's occupation").
- Each blank is its own question. Do not give the same field to two blanks, except tick boxes of one question, or name parts.
- A name asked in parts (first name, middle name, surname): the full name field for each part, with "part": "first", "middle" or "last".
- "(in words)" after a date of birth blank is its own question "Date of birth in words".
- The same printed words in two blocks (e.g. "Academic Qualification" for the mother and the father): use the block's person.
- A line with no question of its own just below another blank, that only gives more room for the same answer (the 2nd and 3rd lines of an address): the same "field" or "label" as that blank, with "next": true.
- A tick box: its choice in "option" (e.g. "Male", "Yes", "OBC").
- "skip": true for office use only, photo, signature, school header lines (email, phone, website), office dates, or anything that is not a question for the parent.
Reply only JSON, leaving out keys that are null or false: {"items":[{"n":1,"field":"childName"},{"n":2,"label":"Caste"},{"n":3,"field":"gender","option":"Boy"},{"n":4,"field":"address"},{"n":5,"field":"address","next":true},{"n":6,"skip":true}]}`;

router.post("/admission-form/auto-mark", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const input = autoMarkSchema.parse(req.body);
    if (!formAi) throw new BadRequestError("AI is not set up on this server. Mark the boxes by hand.");
    const known = input.fields.map(f => `${f.id}: ${f.label}${f.options.length ? ` [${f.options.join("/")}]` : ""}`).join("\n");
    const q = (t: string) => `"${t.replace(/"/g, "'")}"`;
    const list = input.candidates.map(c => `${c.n}: ${c.kind}${c.cells ? ` (${c.cells} boxes)` : ""}${c.text ? ` printed ${q(c.text)}` : ""}${c.after ? ` after ${q(c.after)}` : ""}${c.under ? ` under ${q(c.under)}` : ""}`).join("\n");
    const base = { institutionId, userId: req.user!.userId, userRole: req.user!.role, feature: "ADMISSION_FORM_SCAN" as const, provider: FORM_AI_PROVIDER, model: FORM_AI_MODEL, requestType: input.image ? "vision" : "text" };
    const ask = () => formAi.chat.completions.create({
      model: FORM_AI_MODEL,
      messages: [
        { role: "system", content: AUTO_MARK_PROMPT },
        { role: "user", content: [
          { type: "text" as const, text: `KNOWN fields:\n${known}\n\nBlanks on this page:\n${list}` },
          ...(input.image ? [{ type: "image_url" as const, image_url: FORM_AI_PROVIDER === "openai" ? { url: input.image, detail: "high" as const } : { url: input.image } }] : []),
          ...input.strips.map(url => ({ type: "image_url" as const, image_url: FORM_AI_PROVIDER === "openai" ? { url, detail: "high" as const } : { url } })),
        ] },
      ],
      max_tokens: FORM_AI_PROVIDER === "openai" ? 4000 : 6000,
      temperature: 0,
      response_format: { type: "json_object" },
    });
    let completion;
    try {
      try { completion = await ask(); } catch (first) {
        // Busy: wait as long as the AI asks (at most 20s) and try once more.
        if ((first as { status?: number })?.status !== 429) throw first;
        const after = Number((first as { headers?: Record<string, string> })?.headers?.["retry-after"]);
        await new Promise(r => setTimeout(r, Math.min(20, Number.isFinite(after) && after > 0 ? after : 8) * 1000));
        completion = await ask();
      }
    } catch (err) {
      await recordAiUsage({ ...base, status: "FAILED", error: err instanceof Error ? err.message : String(err) });
      if ((err as { status?: number })?.status === 429) throw new TooManyRequestsError("The AI is busy right now. Please try again in a few minutes, or mark the boxes by hand.");
      throw new BadRequestError("The AI could not read this page. Please mark the boxes by hand.");
    }
    await recordAiUsage({ ...base, status: "SUCCESS", inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens, totalTokens: completion.usage?.total_tokens });
    const raw = completion.choices[0]?.message?.content ?? "";
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const parsed = autoMarkReply.safeParse((() => { try { return JSON.parse(json); } catch { return null; } })());
    if (!parsed.success) throw new BadRequestError("The AI reply could not be read. Please try again or mark by hand.");
    const ids = new Set(input.fields.map(f => f.id));
    const nums = new Set(input.candidates.map(c => c.n));
    const items = parsed.data.items
      .filter(i => nums.has(i.n) && !i.skip)
      .map(i => ({ n: i.n, field: i.field && ids.has(i.field) ? i.field : null, label: i.field && ids.has(i.field) ? null : (i.label?.trim() || null), option: i.option?.trim() || null, part: i.part ?? null, next: !!i.next }))
      .filter(i => i.field || i.label);
    res.json({ success: true, data: { items } });
  } catch (err) { next(err); }
});

router.get("/admission-form/print", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const head = await printHeader(institutionOf(req));
    res.json({ success: true, data: { ...head, application: null, values: { _session: head.session } } });
  } catch (err) { next(err); }
});

router.get("/applications/:id/admission-form/print", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const a = await loadApplication(institutionId, req.params.id as string);
    const head = await printHeader(institutionId, a.academicYearId);
    const std = await academicDb().standard.findFirst({ where: { id: a.standardId, institutionId }, select: { name: true } });
    const values = { ...prefillValues(head.config, { childName: a.childName, dob: a.dob, gender: a.gender, className: std?.name ?? "" }, decryptDetails(a.details)), ...decryptValues((a.admissionForm as { values?: string } | null)?.values) };
    const today = todayIST().split("-").reverse().join("/");
    res.json({ success: true, data: { ...head, application: { applicationNo: a.applicationNo, admissionNo: a.admissionNo, childName: a.childName, className: std?.name ?? "" }, values: { ...values, _applicationNo: a.applicationNo, _admissionNo: a.admissionNo ?? "", _session: head.session, _today: today } } });
  } catch (err) { next(err); }
});

router.post("/applications/:id/actions", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const revision = z.number().int().min(1).parse(req.body?.revision);
    const input = actionSchema.parse(req.body);
    const a = await loadApplication(institutionId, req.params.id as string);
    await assertOpenSession(institutionId, a.academicYearId);
    assertRevision(a.revision, revision);
    const settings = await getSettings(institutionId);
    const by = await actorName(req);
    const stage = a.stage as Stage;
    const open = !a.outcome;
    const need = (ok: boolean, message: string) => { if (!ok) throw new BadRequestError(message); };
    // Registration fee (when the school charges one) must be paid or waived before any decision.
    const regFeeDue = settings.registrationFee != null && Number(settings.registrationFee) > 0 && !feePaid(a.registrationFee);
    const REG_FEE_FIRST = "Take the registration fee first (or mark it waived)";
    let data: Prisma.AdmissionApplicationUpdateManyMutationInput = {};
    let event = input.action as string, note: string | undefined;
    let email: Parameters<typeof notifyParent>[2] | null = null;
    let placeInto: string | null = null;

    switch (input.action) {
      case "REGISTER":
        need(stage === "ENQUIRY" && open, "Only an enquiry can be registered");
        need(!!a.dob, "Add the date of birth first");
        data = { stage: "REGISTERED" };
        break;
      case "REG_FEE":
        need(open && stage !== "ADMITTED", "This application is closed");
        data = { registrationFee: json({ status: input.mode === "WAIVED" ? "WAIVED" : "PAID", mode: input.mode, ref: input.ref, amount: input.amount ?? null, at: new Date().toISOString(), by }) };
        note = input.mode === "WAIVED" ? "Waived" : input.mode === "ONLINE" ? `Online${input.ref ? `, ref ${input.ref}` : ""}` : `At counter${input.ref ? `, receipt ${input.ref}` : ""}`;
        break;
      case "SCHEDULE":
        need(settings.interactionStep, "Interaction is turned off in admission settings");
        need(open && (stage === "REGISTERED" || stage === "INTERACTION"), "A slot can be given only after registration");
        data = { stage: "INTERACTION", interaction: json({ at: input.at, note: input.note, by }) };
        note = input.at;
        email = { kind: "SLOT", at: input.at, note: input.note };
        break;
      case "INTERACTION_DONE": {
        const it = (a.interaction ?? {}) as Record<string, unknown>;
        need(open && stage === "INTERACTION", "Give an interaction slot first");
        data = { interaction: json({ ...it, doneAt: new Date().toISOString(), remark: input.remark, result: input.result, doneBy: by }) };
        note = input.remark;
        break;
      }
      case "SELECT": {
        const fromWaitlist = stage === "SELECTED" && (a.outcome === "WAITLIST" || a.outcome === "LAPSED");
        const ready = open && (stage === "INTERACTION" || (stage === "REGISTERED" && !settings.interactionStep));
        need(ready || fromWaitlist, settings.interactionStep && stage === "REGISTERED" ? "Hold the interaction first" : "This child cannot be selected now");
        need(!regFeeDue, REG_FEE_FIRST);
        const dueOn = input.dueOn ?? addDays(settings.admissionFeeDays);
        need(dueOn >= today(), "The fee date cannot be in the past");
        data = { stage: "SELECTED", outcome: null, waitlistRank: null, offer: json({ sentAt: new Date().toISOString(), dueOn, by }) };
        note = `Fee due by ${dueOn}`;
        email = { kind: "OFFER", dueOn };
        break;
      }
      case "WAITLIST": {
        need(open && (stage === "REGISTERED" || stage === "INTERACTION" || (stage === "SELECTED" && !feePaid(a.admissionFee))), "This child cannot be waitlisted now");
        need(!regFeeDue, REG_FEE_FIRST);
        const last = await academicDb().admissionApplication.aggregate({ where: { institutionId, academicYearId: a.academicYearId, standardId: a.standardId, outcome: "WAITLIST" }, _max: { waitlistRank: true } });
        const rank = (last._max.waitlistRank ?? 0) + 1;
        data = { stage: "SELECTED", outcome: "WAITLIST", waitlistRank: rank };
        note = `Waitlist #${rank}`;
        email = { kind: "WAITLIST", rank };
        break;
      }
      case "NOT_SELECTED":
        need(stage !== "ADMITTED" && (open || a.outcome === "WAITLIST"), "This application is already closed");
        data = { outcome: "NOT_SELECTED", waitlistRank: null };
        note = input.reason || undefined;
        email = { kind: "NOT_SELECTED", reason: input.reason || undefined };
        break;
      case "WITHDRAW":
        need(!a.studentId, "This child is already a student. Use the class to mark them withdrawn.");
        need(a.outcome !== "WITHDRAWN", "Already withdrawn");
        data = { outcome: "WITHDRAWN", waitlistRank: null };
        note = input.reason || undefined;
        break;
      case "LAPSE":
        need(open && stage === "SELECTED" && !!a.offer && !feePaid(a.admissionFee), "Only an unpaid offer can lapse");
        data = { outcome: "LAPSED" };
        break;
      case "REOPEN": {
        need(a.outcome === "NOT_SELECTED" || a.outcome === "WITHDRAWN" || a.outcome === "LAPSED", "This application is not closed");
        data = { outcome: null };
        // A lapsed offer gets a fresh fee date, or it would lapse again right away.
        const offer = a.offer as { dueOn?: string } | null;
        if (a.outcome === "LAPSED" && offer?.dueOn && offer.dueOn < todayIST()) {
          const dueOn = addDays(settings.admissionFeeDays);
          data.offer = json({ ...offer, dueOn });
          note = `New fee date ${dueOn}`;
        }
        break;
      }
      case "ADM_FEE":
        need(open && stage === "SELECTED" && !!a.offer, "Send the offer first");
        data = { admissionFee: json({ status: input.mode === "WAIVED" ? "WAIVED" : "PAID", mode: input.mode, ref: input.ref, amount: input.amount ?? null, at: new Date().toISOString(), by }) };
        note = input.mode === "WAIVED" ? "Waived" : input.mode === "ONLINE" ? `Online${input.ref ? `, ref ${input.ref}` : ""}` : `At counter${input.ref ? `, receipt ${input.ref}` : ""}`;
        break;
      case "DOCUMENTS": {
        need(!a.outcome || a.outcome === "WAITLIST", "This application is closed");
        const docList = (Array.isArray(settings.documents) ? settings.documents : []) as { id: string; name: string }[];
        const current = (Array.isArray(a.documents) ? a.documents : []) as DocTick[];
        const merged = new Map(current.map(t => [t.id, t]));
        for (const item of input.items) {
          const name = docList.find(d => d.id === item.id)?.name ?? merged.get(item.id)?.name;
          if (!name) throw new BadRequestError("Unknown document");
          merged.set(item.id, item.seen ? { id: item.id, name, seen: true, seenAt: new Date().toISOString(), seenBy: by, note: item.note } : { id: item.id, name, seen: false });
        }
        data = { documents: json([...merged.values()]) };
        event = "DOCUMENTS_UPDATED";
        note = input.items.filter(i => i.seen).map(i => merged.get(i.id)?.name).filter(Boolean).join(", ") || undefined;
        break;
      }
      case "ADMIT": {
        need(open && stage === "SELECTED", "Select the child and send the offer first");
        need(feePaid(a.admissionFee), "Mark the admission fee as paid (or waived) first");
        {
          const cfg = readAdmissionForm(settings.admissionForm);
          need(!cfg.enabled || !cfg.requiredForAdmit || formDone(a.admissionForm), cfg.mode === "ONLINE" ? "The admission form is not filled yet" : "Mark the admission form as received first");
        }
        need(!regFeeDue, REG_FEE_FIRST);
        if (input.divisionId) {
          const div = await academicDb().division.findFirst({ where: { id: input.divisionId, institutionId, standardId: a.standardId }, select: { id: true } });
          need(!!div, "That section is not in this class");
        }
        const admissionNo = input.admissionNo ?? await takeAdmissionNo(institutionId);
        data = { stage: "ADMITTED", admissionNo, divisionId: input.divisionId ?? null };
        note = `Admission no ${admissionNo}`;
        email = { kind: "ADMITTED", admissionNo };
        const year = await academicDb().academicYear.findFirst({ where: { id: a.academicYearId, institutionId }, select: { isCurrent: true } });
        if (input.divisionId && year?.isCurrent) placeInto = input.divisionId;
        break;
      }
      case "SET_SECTION": {
        need(stage === "ADMITTED" && !a.studentId, "Only an admitted child who is not placed yet can change section");
        if (input.divisionId) {
          const div = await academicDb().division.findFirst({ where: { id: input.divisionId, institutionId, standardId: a.standardId }, select: { id: true } });
          need(!!div, "That section is not in this class");
        }
        data = { divisionId: input.divisionId };
        break;
      }
    }

    try {
      const result = await academicDb().admissionApplication.updateMany({
        where: { id: a.id, institutionId, revision: a.revision },
        data: { ...data, events: withEvent(a.events, event, by, note), revision: { increment: 1 } },
      });
      if (result.count !== 1) throw new ConflictError("Someone else changed this application. Refresh and try again.");
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") throw new ConflictError("This admission number is already given to another child");
      throw err;
    }

    if (email) await notifyParent(institutionId, a.id, email).catch(() => {});
    let placed: Awaited<ReturnType<typeof placeApplication>> | null = null, placeError: string | null = null;
    if (placeInto) {
      try { placed = await placeApplication(institutionId, a.id, placeInto, by); }
      catch (err) { placeError = err instanceof Error ? err.message : "Admitted, but could not add to the section. Use Place in section."; }
    }
    if (input.action === "ADMIT") {
      logAudit("STUDENT_ADMITTED", { userId: req.user!.userId, actorRole: req.user!.role, institutionId, details: `${a.childName} admitted`, metadata: { applicationNo: a.applicationNo }, category: "ADMIN_ACTION", severity: "INFO" });
    }
    res.json({ success: true, data: { placed, placeError } });
  } catch (err) { next(err); }
});

// ── Sessions: every session with admissions, plus the current and next one ──
router.get("/sessions", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const settings = await getSettings(institutionId);
    const [target, choices, counts] = await Promise.all([
      targetYear(institutionId, settings.academicYearId),
      sessionChoices(institutionId),
      academicDb().admissionApplication.groupBy({ by: ["academicYearId"], where: { institutionId }, _count: { _all: true } }),
    ]);
    const countOf = new Map(counts.map(c => [c.academicYearId, c._count._all]));
    const ids = [...new Set([target.id, ...choices.map(c => c.id), ...counts.map(c => c.academicYearId)])];
    const years = await academicDb().academicYear.findMany({ where: { institutionId, id: { in: ids } }, orderBy: { startDate: "desc" } });
    const current = choices.find(c => c.isCurrent);
    const currentStart = years.find(y => y.id === current?.id)?.startDate ?? new Date();
    res.json({ success: true, data: years.map(y => ({
      id: y.id, label: y.label, isCurrent: y.isCurrent, isTarget: y.id === target.id,
      readOnly: y.startDate < currentStart, applications: countOf.get(y.id) ?? 0,
    })) });
  } catch (err) { next(err); }
});

// ── Placement: admitted children waiting for a section ──────────────────────
router.get("/placement", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const current = await academicDb().academicYear.findFirst({ where: { institutionId, isCurrent: true } });
    const settings = await getSettings(institutionId);
    const standards = await standardsWithSections(institutionId);
    const rows = current ? await academicDb().admissionApplication.findMany({
      where: { institutionId, academicYearId: current.id, stage: "ADMITTED", outcome: null, studentId: null },
      orderBy: [{ standardId: "asc" }, { childName: "asc" }],
    }) : [];
    const counts = await academicDb().student.groupBy({ by: ["divisionId"], where: { institutionId, status: "ACTIVE", divisionId: { not: null } }, _count: { _all: true } });
    const countOf = new Map(counts.map(c => [c.divisionId, c._count._all]));
    const groups = standards.map(s => ({
      standardId: s.id, standardName: s.name,
      sections: s.divisions.map(d => ({ id: d.id, name: d.name, students: countOf.get(d.id) ?? 0 })),
      children: rows.filter(r => r.standardId === s.id).map(r => ({
        id: r.id, revision: r.revision, childName: r.childName, admissionNo: r.admissionNo, divisionId: r.divisionId,
        gender: r.gender, parentName: r.parentName,
        docsPending: docsPending(settings.documents, r.documents),
      })),
    })).filter(g => g.children.length);
    res.json({ success: true, data: { session: current ? { id: current.id, label: current.label } : null, groups } });
  } catch (err) { next(err); }
});

const placeSchema = z.object({ items: z.array(z.object({ id: z.string().uuid(), divisionId: z.string().uuid() })).min(1).max(200) }).strict();
router.post("/placement", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const { items } = placeSchema.parse(req.body);
    const by = await actorName(req);
    const results: Array<Record<string, unknown>> = [];
    for (const item of items) {
      try {
        const placed = await placeApplication(institutionId, item.id, item.divisionId, by);
        results.push({ id: item.id, ok: true, ...placed });
      } catch (err) {
        results.push({ id: item.id, ok: false, error: err instanceof Error ? err.message : "Could not place" });
      }
    }
    res.json({ success: true, data: results });
  } catch (err) { next(err); }
});

export default router;
