// src/services/parentForms.service.ts
//
// Permission slips (Yes/No consent) and single-choice polls. A class teacher
// sends to their own division(s); an admin sends to any divisions or the whole
// school. Parents answer from Parent Mode (inside the student's login), so a
// response belongs to a student. Parents can change their answer until the
// deadline; every answer is kept in `history` as the audit trail.
import { academicDb } from "../utils/academicContext";
import { resolveUsers } from "./userLookup.service";
import { notifyUsers } from "./parentNotify.service";
import { logAudit } from "./audit.service";
import { requireStudent, requireTeacher } from "./parentChat.service";
import { BadRequestError, ForbiddenError, NotFoundError, TooManyRequestsError } from "../utils/errors";

export type FormKind = "SLIP" | "POLL";
export type FormActor = { userId: string; role: "ADMIN" | "TEACHER"; institutionId: string };

export interface CreateFormInput {
  kind: FormKind;
  title: string;
  description?: string;
  options?: string[];
  allowComment: boolean;
  deadline?: Date;
  divisionIds?: string[];
  allDivisions?: boolean;
}

type HistoryEntry = { optionIndex: number; comment: string | null; at: string };

const SLIP_OPTIONS = ["Yes", "No"];

function parseOptions(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function isClosed(form: { closedAt: Date | null; deadline: Date | null }, now = new Date()): boolean {
  return form.closedAt != null || (form.deadline != null && form.deadline.getTime() <= now.getTime());
}

function normaliseOptions(kind: FormKind, options?: string[]): string[] {
  if (kind === "SLIP") return SLIP_OPTIONS;
  const cleaned = [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))];
  if (cleaned.length < 2 || cleaned.length > 6) throw new BadRequestError("A poll needs between 2 and 6 different options");
  if (cleaned.some((o) => o.length > 80)) throw new BadRequestError("Each option must be 80 characters or fewer");
  return cleaned;
}

// ── Targets ──────────────────────────────────────────────────────────────────

/** Divisions the actor may send to: a teacher's own class divisions, or any for an admin. */
export async function listTargetDivisions(actor: FormActor) {
  const db = academicDb();
  if (actor.role === "TEACHER") {
    const teacher = await requireTeacher(actor.userId, actor.institutionId);
    const divisions = await db.division.findMany({
      where: { institutionId: actor.institutionId, classTeacherId: teacher.id },
      select: { id: true, name: true, standard: { select: { name: true } } },
      orderBy: [{ standard: { order: "asc" } }, { name: "asc" }],
    });
    return divisions.map((d) => ({ id: d.id, label: `${d.standard.name} ${d.name}` }));
  }
  const divisions = await db.division.findMany({
    where: { institutionId: actor.institutionId },
    select: { id: true, name: true, standard: { select: { name: true } } },
    orderBy: [{ standard: { order: "asc" } }, { name: "asc" }],
  });
  return divisions.map((d) => ({ id: d.id, label: `${d.standard.name} ${d.name}` }));
}

async function audienceStudents(institutionId: string, form: { allDivisions: boolean; targets: { divisionId: string }[] }) {
  return academicDb().student.findMany({
    where: {
      institutionId,
      status: "ACTIVE",
      ...(form.allDivisions ? {} : { divisionId: { in: form.targets.map((t) => t.divisionId) } }),
    },
    select: { id: true, userId: true, rollNo: true, division: { select: { name: true, standard: { select: { name: true } } } } },
  });
}

// ── Create / close ───────────────────────────────────────────────────────────

export async function createForm(actor: FormActor, input: CreateFormInput) {
  const options = normaliseOptions(input.kind, input.options);
  if (input.deadline && input.deadline.getTime() <= Date.now()) throw new BadRequestError("The deadline must be in the future");

  const allowed = await listTargetDivisions(actor);
  if (actor.role === "TEACHER" && allowed.length === 0) {
    throw new ForbiddenError("Only a class teacher can send forms to parents");
  }
  const allowedIds = new Set(allowed.map((d) => d.id));

  let allDivisions = false;
  let divisionIds: string[];
  if (actor.role === "ADMIN" && input.allDivisions) {
    allDivisions = true;
    divisionIds = [];
  } else {
    divisionIds = input.divisionIds?.length ? [...new Set(input.divisionIds)] : actor.role === "TEACHER" ? [...allowedIds] : [];
    if (divisionIds.length === 0) throw new BadRequestError("Choose at least one class");
    if (divisionIds.some((id) => !allowedIds.has(id))) throw new ForbiddenError("You can only send to your own classes");
  }

  const form = await academicDb().parentForm.create({
    data: {
      institutionId: actor.institutionId,
      kind: input.kind,
      title: input.title,
      description: input.description || null,
      options,
      allowComment: input.allowComment,
      deadline: input.deadline ?? null,
      allDivisions,
      createdByUserId: actor.userId,
      createdByRole: actor.role,
      targets: { create: divisionIds.map((divisionId) => ({ institutionId: actor.institutionId, divisionId })) },
    },
    include: { targets: true },
  });

  const students = await audienceStudents(actor.institutionId, form);
  const dueText = form.deadline ? ` Reply by ${form.deadline.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}.` : "";
  await notifyUsers({
    institutionId: actor.institutionId,
    userIds: students.map((s) => s.userId),
    title: input.kind === "SLIP" ? `Permission slip: ${form.title}` : `New poll: ${form.title}`,
    message: `Open Parent Mode to respond.${dueText}`,
    tag: "parent_form",
    recipientType: "STUDENT",
    sentById: actor.userId,
  });

  logAudit("PARENT_FORM_CREATED", { userId: actor.userId, actorRole: actor.role, institutionId: actor.institutionId, details: `${form.kind} ${form.id}: ${form.title}` });
  return { id: form.id, audience: students.length };
}

async function requireManagedForm(actor: FormActor, formId: string) {
  const form = await academicDb().parentForm.findFirst({
    where: { id: formId, institutionId: actor.institutionId, ...(actor.role === "TEACHER" ? { createdByUserId: actor.userId } : {}) },
    include: { targets: true },
  });
  if (!form) throw new NotFoundError("Form not found");
  return form;
}

export async function closeForm(actor: FormActor, formId: string): Promise<void> {
  const form = await requireManagedForm(actor, formId);
  if (form.closedAt) return;
  await academicDb().parentForm.update({ where: { id: form.id }, data: { closedAt: new Date() } });
  logAudit("PARENT_FORM_CLOSED", { userId: actor.userId, actorRole: actor.role, institutionId: actor.institutionId, details: `form ${form.id}` });
}

// ── Reminders ────────────────────────────────────────────────────────────────

const MANUAL_REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const AUTO_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUTO_SKIP_IF_REMINDED_MS = 12 * 60 * 60 * 1000;

type RemindableForm = {
  id: string;
  institutionId: string;
  kind: string;
  title: string;
  deadline: Date | null;
  allDivisions: boolean;
  targets: { divisionId: string }[];
};

/** Parents (student logins) in the audience who have not answered yet. */
async function nonResponderUserIds(form: RemindableForm): Promise<string[]> {
  const [students, responses] = await Promise.all([
    audienceStudents(form.institutionId, form),
    academicDb().parentFormResponse.findMany({ where: { formId: form.id, institutionId: form.institutionId }, select: { studentId: true } }),
  ]);
  const answered = new Set(responses.map((r) => r.studentId));
  return students.filter((s) => !answered.has(s.id)).map((s) => s.userId);
}

async function sendReminder(form: RemindableForm, sentById?: string): Promise<number> {
  const userIds = await nonResponderUserIds(form);
  if (userIds.length === 0) return 0;
  const dueText = form.deadline ? ` Reply by ${form.deadline.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}.` : "";
  await notifyUsers({
    institutionId: form.institutionId,
    userIds,
    title: `Reminder: ${form.title}`,
    message: `${form.kind === "SLIP" ? "Your reply to this permission slip is still pending." : "You haven't answered this poll yet."} Open Parent Mode to respond.${dueText}`,
    tag: "parent_form",
    recipientType: "STUDENT",
    sentById,
  });
  return userIds.length;
}

/** Sender taps "Remind non-responders". Open forms only, at most once every 6 hours. */
export async function remindNonResponders(actor: FormActor, formId: string): Promise<{ reminded: number }> {
  const form = await requireManagedForm(actor, formId);
  if (isClosed(form)) throw new BadRequestError("This form is closed");
  if (form.lastRemindedAt && Date.now() - form.lastRemindedAt.getTime() < MANUAL_REMINDER_COOLDOWN_MS) {
    throw new TooManyRequestsError("You already sent a reminder recently. Try again in a few hours.");
  }
  // Claim the cooldown first so two quick taps can't both send.
  const claimed = await academicDb().parentForm.updateMany({
    where: { id: form.id, institutionId: actor.institutionId, lastRemindedAt: form.lastRemindedAt },
    data: { lastRemindedAt: new Date() },
  });
  if (claimed.count === 0) throw new TooManyRequestsError("A reminder was just sent for this form.");
  const reminded = await sendReminder(form, actor.userId);
  logAudit("PARENT_FORM_REMINDED", { userId: actor.userId, actorRole: actor.role, institutionId: actor.institutionId, details: `form ${form.id}: ${reminded} parent(s)` });
  return { reminded };
}

/**
 * Cron entry: one automatic reminder per form, once its deadline is within 24h.
 * Must run inside an academic client scope.
 */
export async function sendAutomaticFormReminders(): Promise<number> {
  const now = new Date();
  const forms = await academicDb().parentForm.findMany({
    where: {
      closedAt: null,
      reminderSentAt: null,
      deadline: { gt: now, lte: new Date(now.getTime() + AUTO_REMINDER_WINDOW_MS) },
    },
    include: { targets: true },
  });

  let sent = 0;
  for (const form of forms) {
    try {
      // Claim before sending so overlapping cron runs can't double-send.
      const claimed = await academicDb().parentForm.updateMany({
        where: { id: form.id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (claimed.count === 0) continue;
      // A manual reminder just went out — don't nag again straight away.
      if (form.lastRemindedAt && now.getTime() - form.lastRemindedAt.getTime() < AUTO_SKIP_IF_REMINDED_MS) continue;
      await sendReminder(form);
      await academicDb().parentForm.update({ where: { id: form.id }, data: { lastRemindedAt: now } });
      sent++;
    } catch (err) {
      console.error(`[Form Reminder] Failed for form ${form.id}:`, err);
    }
  }
  return sent;
}

// ── Creator views ────────────────────────────────────────────────────────────

export async function listFormsForCreator(actor: FormActor) {
  const db = academicDb();
  const forms = await db.parentForm.findMany({
    where: { institutionId: actor.institutionId, ...(actor.role === "TEACHER" ? { createdByUserId: actor.userId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { targets: true },
  });
  if (forms.length === 0) return [];

  const [answers, perDivision, creators] = await Promise.all([
    db.parentFormResponse.groupBy({ by: ["formId"], where: { institutionId: actor.institutionId, formId: { in: forms.map((f) => f.id) } }, _count: { _all: true } }),
    db.student.groupBy({ by: ["divisionId"], where: { institutionId: actor.institutionId, status: "ACTIVE" }, _count: { _all: true } }),
    resolveUsers(forms.map((f) => f.createdByUserId), { id: true, name: true }),
  ]);
  const answered = new Map(answers.map((a) => [a.formId, a._count._all] as [string, number]));
  const sizeByDivision = new Map(perDivision.map((d) => [d.divisionId, d._count._all] as [string | null, number]));
  const everyone = perDivision.reduce((n, d) => n + d._count._all, 0);

  return forms.map((f) => ({
    id: f.id,
    kind: f.kind as FormKind,
    title: f.title,
    options: parseOptions(f.options),
    deadline: f.deadline ? f.deadline.toISOString() : null,
    closed: isClosed(f),
    createdAt: f.createdAt.toISOString(),
    createdByName: creators.get(f.createdByUserId)?.name ?? "Unknown",
    allDivisions: f.allDivisions,
    audience: f.allDivisions ? everyone : f.targets.reduce((n, t) => n + (sizeByDivision.get(t.divisionId) ?? 0), 0),
    answered: answered.get(f.id) ?? 0,
  }));
}

export async function getFormResults(actor: FormActor, formId: string) {
  const form = await requireManagedForm(actor, formId);
  const db = academicDb();
  const [students, responses] = await Promise.all([
    audienceStudents(actor.institutionId, form),
    db.parentFormResponse.findMany({ where: { formId: form.id, institutionId: actor.institutionId } }),
  ]);
  const users = await resolveUsers(students.map((s) => s.userId), { id: true, name: true });
  const byStudent = new Map(responses.map((r) => [r.studentId, r]));
  const options = parseOptions(form.options);

  const rows = students
    .map((s) => {
      const r = byStudent.get(s.id);
      return {
        studentId: s.id,
        name: users.get(s.userId)?.name ?? "Student",
        rollNo: s.rollNo,
        className: s.division ? `${s.division.standard.name} ${s.division.name}` : null,
        optionIndex: r ? r.optionIndex : null,
        comment: r?.comment ?? null,
        respondedAt: r ? r.respondedAt.toISOString() : null,
        changes: r ? Math.max(0, (Array.isArray(r.history) ? r.history.length : 1) - 1) : 0,
      };
    })
    .sort((a, b) => (a.className ?? "").localeCompare(b.className ?? "") || Number(a.rollNo) - Number(b.rollNo) || a.name.localeCompare(b.name));

  return {
    id: form.id,
    kind: form.kind as FormKind,
    title: form.title,
    description: form.description,
    options,
    deadline: form.deadline ? form.deadline.toISOString() : null,
    closed: isClosed(form),
    counts: options.map((label, i) => ({ label, count: rows.filter((r) => r.optionIndex === i).length })),
    total: rows.length,
    answered: rows.filter((r) => r.optionIndex !== null).length,
    students: rows,
  };
}

// ── Parent (student login) ───────────────────────────────────────────────────

function visibleToStudent(divisionId: string | null) {
  return { OR: [{ allDivisions: true }, ...(divisionId ? [{ targets: { some: { divisionId } } }] : [])] };
}

export async function listFormsForStudent(userId: string, institutionId: string) {
  const student = await requireStudent(userId, institutionId);
  const db = academicDb();
  const forms = await db.parentForm.findMany({
    where: { institutionId, ...visibleToStudent(student.divisionId) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const [responses, creators] = await Promise.all([
    db.parentFormResponse.findMany({ where: { institutionId, studentId: student.id, formId: { in: forms.map((f) => f.id) } } }),
    resolveUsers(forms.map((f) => f.createdByUserId), { id: true, name: true }),
  ]);
  const mine = new Map(responses.map((r) => [r.formId, r]));

  const items = forms.map((f) => {
    const r = mine.get(f.id);
    return {
      id: f.id,
      kind: f.kind as FormKind,
      title: f.title,
      description: f.description,
      options: parseOptions(f.options),
      allowComment: f.allowComment,
      deadline: f.deadline ? f.deadline.toISOString() : null,
      closed: isClosed(f),
      createdAt: f.createdAt.toISOString(),
      createdByName: creators.get(f.createdByUserId)?.name ?? "School",
      myResponse: r ? { optionIndex: r.optionIndex, comment: r.comment, respondedAt: r.respondedAt.toISOString() } : null,
    };
  });
  return { forms: items, pending: items.filter((i) => !i.closed && !i.myResponse).length };
}

export async function pendingFormCountForStudent(userId: string, institutionId: string): Promise<number> {
  const student = await academicDb().student.findFirst({ where: { userId, institutionId }, select: { id: true, divisionId: true } });
  if (!student) return 0;
  const now = new Date();
  return academicDb().parentForm.count({
    where: {
      institutionId,
      closedAt: null,
      AND: [{ OR: [{ deadline: null }, { deadline: { gt: now } }] }, visibleToStudent(student.divisionId)],
      responses: { none: { studentId: student.id } },
    },
  });
}

export async function respondToForm(userId: string, institutionId: string, formId: string, input: { optionIndex: number; comment?: string }) {
  const student = await requireStudent(userId, institutionId);
  if (student.status !== "ACTIVE") throw new ForbiddenError("This account cannot respond");

  const form = await academicDb().parentForm.findFirst({
    where: { id: formId, institutionId, ...visibleToStudent(student.divisionId) },
  });
  if (!form) throw new NotFoundError("Form not found");
  if (isClosed(form)) throw new BadRequestError("This form is closed");

  const options = parseOptions(form.options);
  if (input.optionIndex < 0 || input.optionIndex >= options.length) throw new BadRequestError("Invalid choice");
  const comment = form.allowComment ? input.comment?.trim() || null : null;

  const entry: HistoryEntry = { optionIndex: input.optionIndex, comment, at: new Date().toISOString() };
  const existing = await academicDb().parentFormResponse.findUnique({ where: { formId_studentId: { formId, studentId: student.id } } });
  const history = [...(Array.isArray(existing?.history) ? (existing.history as HistoryEntry[]) : []), entry];

  const saved = await academicDb().parentFormResponse.upsert({
    where: { formId_studentId: { formId, studentId: student.id } },
    create: { institutionId, formId, studentId: student.id, optionIndex: input.optionIndex, comment, history },
    update: { optionIndex: input.optionIndex, comment, history },
  });
  return { optionIndex: saved.optionIndex, comment: saved.comment, respondedAt: saved.respondedAt.toISOString() };
}
