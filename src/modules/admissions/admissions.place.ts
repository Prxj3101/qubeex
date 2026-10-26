import { prisma } from "../../utils/prisma";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError } from "../../utils/errors";
import { createNotification } from "../../services/notification.service";
import { sendAdmissionEmail } from "../../services/email.service";
import { decryptDetails, feePaid, getSettings, lastNote, sectionLabel, withEvent } from "./admissions.shared";
import { readAdmissionForm } from "./admissions.form";
import { createAdmittedStudent, nextRollNo } from "./admission-student";

type ParentEmail =
  | { kind: "SLOT"; at: string; note: string }
  | { kind: "OFFER"; dueOn: string }
  | { kind: "WAITLIST"; rank: number }
  | { kind: "NOT_SELECTED"; reason?: string }
  | { kind: "ADMITTED"; admissionNo: string }
  | { kind: "RECEIVED" }
  | { kind: "LOGIN"; studentId: string; tempPassword: string; section: string }
  | { kind: "LAPSED"; dueOn: string };

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Emails the parent about one step. Never throws into the caller's flow. */
export async function notifyParent(institutionId: string, applicationId: string, msg: ParentEmail) {
  const a = await academicDb().admissionApplication.findFirst({ where: { id: applicationId, institutionId } });
  if (!a) return;
  const details = decryptDetails(a.details);
  if (!details.email) return false;
  const institution = await prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true, institutionCode: true, logoUrl: true } });
  if (!institution) return false;
  const school = institution.name;
  const link = `${process.env.FRONTEND_URL ?? ""}/apply/${institution.institutionCode}/status/${a.statusToken}`;
  const child = a.childName;
  const appNo = { label: "Application number", value: a.applicationNo };
  const childFact = { label: "Child", value: child };
  const base = { to: details.email, schoolName: school, logoUrl: institution.logoUrl, link, linkLabel: "See application status" };
  switch (msg.kind) {
    case "RECEIVED":
      return sendAdmissionEmail({ ...base, subject: `Application received for ${child}`, badge: "Application received", tone: "info", heading: "We have received your application", lines: [`Thank you for applying to ${school} for ${child}.`, "The school office will contact you about the next step."], facts: [childFact, appNo] });
    case "SLOT":
      return sendAdmissionEmail({ ...base, subject: `Interaction for ${child} on ${when(msg.at)}`, badge: "Interaction scheduled", tone: "blue", heading: "Your interaction is scheduled", lines: [`Please come to ${school} with ${child} at the time below.`], note: msg.note?.trim() || undefined, facts: [{ label: "When", value: when(msg.at) }, childFact, appNo] });
    case "OFFER": {
      const form = readAdmissionForm((await getSettings(institutionId)).admissionForm);
      const formLine = !form.enabled ? [] : form.mode === "ONLINE"
        ? ["Please also fill the admission form online using the button below."]
        : ["Please collect the admission form from the school office, fill it and bring it back with the documents."];
      const extraLink = form.enabled && form.mode === "ONLINE" ? { url: `${process.env.FRONTEND_URL ?? ""}/apply/${institution.institutionCode}/admission-form/${a.statusToken}`, label: "Fill the admission form" } : undefined;
      return sendAdmissionEmail({ ...base, extraLink, subject: `🎉 Congratulations! ${child} has been selected`, badge: "Selected", tone: "good", heading: `${child} has been selected! 🥳`, lines: [`Congratulations! We are happy to offer ${child} a seat at ${school}.`, "Please pay the admission fee and bring the original documents to the school office by the date below. If the fee is not paid by then, the seat may be offered to another child.", ...formLine], facts: [{ label: "Pay fee by", value: day(msg.dueOn) }, childFact, appNo] });
    }
    case "WAITLIST":
      return sendAdmissionEmail({ ...base, subject: `${child} is on the waitlist`, badge: "Waitlist", tone: "wait", heading: "Your application is on the waitlist", lines: ["We will email you if a seat becomes free."], facts: [{ label: "Waitlist number", value: String(msg.rank) }, childFact, appNo] });
    case "NOT_SELECTED":
      return sendAdmissionEmail({ ...base, subject: `About your application for ${child}`, badge: "Update", tone: "plain", heading: "About your application", lines: [`Thank you for your interest in ${school}. We are sorry that we cannot offer ${child} a seat this time.`], note: msg.reason?.trim() || undefined, noteLabel: "REASON", facts: [childFact, appNo] });
    case "ADMITTED":
      return sendAdmissionEmail({ ...base, subject: `Admission confirmed for ${child}`, badge: "Admission confirmed", tone: "good", heading: `Welcome to ${school}!`, lines: [`${child}'s admission is confirmed.`, "You will get the QubeEx app login once the class and section are assigned."], facts: [{ label: "Admission number", value: msg.admissionNo }, childFact, appNo] });
    case "LAPSED":
      return sendAdmissionEmail({ ...base, subject: `About ${child}'s admission offer`, badge: "Offer expired", tone: "plain", heading: "The admission offer has expired", lines: [`The admission fee for ${child} was not paid by ${day(msg.dueOn)}, so the seat offer has expired.`, "If you still want the seat, please contact the school office as soon as possible."], facts: [{ label: "Fee was due by", value: day(msg.dueOn) }, childFact, appNo] });
    case "LOGIN":
      return sendAdmissionEmail({ ...base, link: undefined, subject: `QubeEx login for ${child}`, badge: "App login", tone: "good", heading: `${child} is now in ${msg.section}`, lines: ["Open the QubeEx app, log in with the student ID and this password, and set a new password. Parents can see attendance, fees and updates from the same login."], facts: [{ label: "Student ID", value: msg.studentId }, { label: "Temporary password", value: msg.tempPassword }] });
  }
}

const RESEND_LABELS: Record<ParentEmail["kind"], string> = {
  RECEIVED: "Application received", SLOT: "Interaction slot", OFFER: "Selected, pay the fee", WAITLIST: "Waitlist",
  NOT_SELECTED: "Not selected", ADMITTED: "Admission confirmed", LOGIN: "App login", LAPSED: "Offer expired",
};

/**
 * Sends the parent the email that matches where the application is now
 * (the latest one they should have got), for when the first one did not
 * reach them. Logged in the history.
 */
export async function resendParentEmail(institutionId: string, applicationId: string, by: string) {
  const db = academicDb();
  const a = await db.admissionApplication.findFirst({ where: { id: applicationId, institutionId } });
  if (!a) throw new BadRequestError("Application not found");
  const email = decryptDetails(a.details).email;
  if (!email) throw new BadRequestError("This application has no email. Add the parent's email in the details first.");
  const interaction = a.interaction as { at?: string; doneAt?: string; note?: string } | null;
  const offer = a.offer as { dueOn?: string } | null;
  let msg: ParentEmail;
  if (a.outcome === "WAITLIST") msg = { kind: "WAITLIST", rank: a.waitlistRank ?? 0 };
  else if (a.outcome === "NOT_SELECTED") msg = { kind: "NOT_SELECTED", reason: lastNote(a.events, "NOT_SELECTED") };
  else if (a.outcome === "LAPSED" && offer?.dueOn) msg = { kind: "LAPSED", dueOn: offer.dueOn };
  else if (a.outcome) throw new BadRequestError("This application is closed, so there is no email to send again.");
  else if (a.stage === "ADMITTED") {
    const student = a.studentId ? await db.student.findFirst({ where: { id: a.studentId, institutionId }, select: { studentId: true, tempPassword: true } }) : null;
    const division = a.divisionId ? await db.division.findFirst({ where: { id: a.divisionId, institutionId }, select: { name: true, standard: { select: { name: true } } } }) : null;
    msg = student?.tempPassword
      ? { kind: "LOGIN", studentId: student.studentId, tempPassword: student.tempPassword, section: division ? sectionLabel(division.standard.name, division.name) : "class" }
      : { kind: "ADMITTED", admissionNo: a.admissionNo ?? "" };
  } else if (a.stage === "SELECTED" && offer?.dueOn) msg = { kind: "OFFER", dueOn: offer.dueOn };
  else if (a.stage === "INTERACTION" && interaction?.at && !interaction.doneAt) msg = { kind: "SLOT", at: interaction.at, note: interaction.note ?? "" };
  else msg = { kind: "RECEIVED" };

  const sent = await notifyParent(institutionId, a.id, msg);
  if (!sent) throw new BadRequestError("The email could not be sent. Please try again in a minute.");
  const label = RESEND_LABELS[msg.kind];
  await db.admissionApplication.update({ where: { id: a.id }, data: { events: withEvent(a.events, "EMAIL_RESENT", by, `${label} to ${email}`) } });
  return { email, label };
}

/** Today's date in India (YYYY-MM-DD). */
export const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/**
 * Offers whose admission fee date has passed without payment lapse by
 * themselves (the seat can then go to the waitlist). Runs whenever the
 * school's admissions or a parent's status page are opened, so it works for
 * every school's own database too. The parent gets an email.
 */
export async function lapseOverdueOffers(institutionId: string) {
  const db = academicDb();
  const today = todayIST();
  const rows = await db.admissionApplication.findMany({
    where: { institutionId, stage: "SELECTED", outcome: null },
    select: { id: true, revision: true, offer: true, admissionFee: true, events: true },
  });
  for (const r of rows) {
    const dueOn = (r.offer as { dueOn?: string } | null)?.dueOn;
    if (!dueOn || dueOn >= today || feePaid(r.admissionFee)) continue;
    const done = await db.admissionApplication.updateMany({
      where: { id: r.id, revision: r.revision, outcome: null },
      data: { outcome: "LAPSED", waitlistRank: null, revision: { increment: 1 }, events: withEvent(r.events, "LAPSE", "System", `Fee not paid by ${day(dueOn)}`) },
    });
    if (done.count === 1) await notifyParent(institutionId, r.id, { kind: "LAPSED", dueOn }).catch(() => {});
  }
}

/**
 * Places one admitted child in a section of the current session: creates the
 * student (ID, login, enrollment), links it to the application, tells the
 * class teacher and emails the parent the login. Claims the application first
 * so two clicks can never create two students.
 */
export async function placeApplication(institutionId: string, applicationId: string, divisionId: string, by: string) {
  const db = academicDb();
  const a = await db.admissionApplication.findFirst({ where: { id: applicationId, institutionId } });
  if (!a) throw new BadRequestError("Application not found");
  if (a.stage !== "ADMITTED" || a.outcome) throw new BadRequestError(`${a.childName} is not admitted`);
  if (a.studentId) throw new BadRequestError(`${a.childName} is already in a class`);
  const year = await db.academicYear.findFirst({ where: { id: a.academicYearId, institutionId }, select: { isCurrent: true, label: true } });
  if (!year?.isCurrent) throw new BadRequestError(`${a.childName} joins in ${year?.label ?? "another session"}. Place them once that session has started.`);
  const division = await db.division.findFirst({ where: { id: divisionId, institutionId, standardId: a.standardId }, select: { id: true, name: true, classTeacherId: true, standard: { select: { name: true } } } });
  if (!division) throw new BadRequestError("That section is not in this child's class");

  const claim = await db.admissionApplication.updateMany({ where: { id: a.id, revision: a.revision, studentId: null }, data: { revision: { increment: 1 } } });
  if (claim.count !== 1) throw new ConflictError(`${a.childName} was changed by someone else. Refresh and try again.`);

  const details = decryptDetails(a.details);
  const { student, tempPassword } = await createAdmittedStudent({
    institutionId, standardId: a.standardId, divisionId, childName: a.childName, dob: a.dob, gender: a.gender, details,
    rollNo: await nextRollNo(institutionId, divisionId),
  });
  const section = sectionLabel(division.standard.name, division.name);
  await db.admissionApplication.update({ where: { id: a.id }, data: {
    studentId: student.id, divisionId, revision: { increment: 1 },
    events: withEvent(a.events, "PLACED", by, `${section}, student ID ${student.studentId}`),
  } });

  if (division.classTeacherId) {
    const teacher = await db.teacher.findFirst({ where: { id: division.classTeacherId, institutionId }, select: { userId: true } });
    if (teacher) {
      try {
        await createNotification({ title: "New student in your class", message: `${a.childName} has joined ${section} (admission no ${a.admissionNo}).`, tag: "ADMISSIONS", recipientType: "USER", recipients: [{ institutionId, userId: teacher.userId }] });
      } catch { /* non-blocking */ }
    }
  }
  await notifyParent(institutionId, a.id, { kind: "LOGIN", studentId: student.studentId, tempPassword, section }).catch(() => {});
  return { studentId: student.studentId, tempPassword, section, childName: a.childName };
}
