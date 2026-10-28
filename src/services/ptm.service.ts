// src/services/ptm.service.ts
//
// Parent-teacher meeting scheduler. A teacher publishes a session (date, time
// window, slot length); equal-length slots are generated up front and a parent
// books ONE slot per session from Parent Mode. Parents only see sessions of
// teachers who teach their child (class teacher + this year's subject teachers),
// and never see which other students booked which slot.
import { academicDb } from "../utils/academicContext";
import { Prisma } from "../generated/prisma/client";
import { resolveUsers } from "./userLookup.service";
import { notifyUsers } from "./parentNotify.service";
import { requireStudent, requireTeacher, eligibleTeachersForStudent } from "./parentChat.service";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../utils/errors";

const MIN_CANCEL_NOTICE_MS = 2 * 60 * 60 * 1000;
const MAX_SLOTS = 60;

export interface CreateSessionInput {
  title: string;
  date: string;       // YYYY-MM-DD (IST)
  startTime: string;  // HH:mm
  endTime: string;    // HH:mm
  slotMinutes: number;
  location?: string;
  note?: string;
}

// ── Time helpers (everything is IST) ─────────────────────────────────────────

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** Calendar date in IST as YYYY-MM-DD. */
export function istDateString(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function slotStart(dateStr: string, startMinute: number): Date {
  return new Date(`${dateStr}T${hhmm(startMinute)}:00+05:30`);
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function prettyDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

// ── Teacher ──────────────────────────────────────────────────────────────────

/** Active students this teacher teaches (class teacher + this year's assignments). */
async function parentsOfTeacher(institutionId: string, teacherId: string) {
  const db = academicDb();
  const [own, assigned] = await Promise.all([
    db.division.findMany({ where: { institutionId, classTeacherId: teacherId }, select: { id: true } }),
    db.divisionAssignment.findMany({
      where: { institutionId, teacherId, academicYear: { isCurrent: true } },
      select: { divisionId: true },
    }),
  ]);
  const divisionIds = [...new Set([...own.map((d) => d.id), ...assigned.map((a) => a.divisionId)])];
  if (divisionIds.length === 0) return [];
  return db.student.findMany({ where: { institutionId, status: "ACTIVE", divisionId: { in: divisionIds } }, select: { userId: true } });
}

export async function createSession(userId: string, institutionId: string, input: CreateSessionInput) {
  const teacher = await requireTeacher(userId, institutionId);
  if (teacher.status !== "ACTIVE") throw new ForbiddenError("This account cannot schedule meetings");

  const start = minutesOf(input.startTime);
  const end = minutesOf(input.endTime);
  if (end <= start) throw new BadRequestError("The end time must be after the start time");
  if (input.slotMinutes < 5 || input.slotMinutes > 60) throw new BadRequestError("Slots must be between 5 and 60 minutes");
  const count = Math.floor((end - start) / input.slotMinutes);
  if (count < 1) throw new BadRequestError("The time window is shorter than one slot");
  if (count > MAX_SLOTS) throw new BadRequestError(`That would create more than ${MAX_SLOTS} slots — shorten the window or lengthen the slots`);
  if (slotStart(input.date, start).getTime() <= Date.now()) throw new BadRequestError("Choose a date and time in the future");

  const session = await academicDb().ptmSession.create({
    data: {
      institutionId,
      teacherId: teacher.id,
      title: input.title,
      date: new Date(`${input.date}T00:00:00.000Z`),
      startMinute: start,
      endMinute: start + count * input.slotMinutes,
      slotMinutes: input.slotMinutes,
      location: input.location || null,
      note: input.note || null,
      slots: {
        create: Array.from({ length: count }, (_, i) => ({
          institutionId,
          startMinute: start + i * input.slotMinutes,
          endMinute: start + (i + 1) * input.slotMinutes,
        })),
      },
    },
  });

  const users = await resolveUsers([userId], { id: true, name: true });
  const parents = await parentsOfTeacher(institutionId, teacher.id);
  await notifyUsers({
    institutionId,
    userIds: parents.map((p) => p.userId),
    title: `Parent-teacher meeting: ${session.title}`,
    message: `${users.get(userId)?.name ?? "A teacher"} opened slots on ${prettyDate(input.date)}. Book one in Parent Mode.`,
    tag: "ptm",
    recipientType: "STUDENT",
    sentById: userId,
  });
  return { id: session.id, slots: count };
}

async function requireOwnSession(userId: string, institutionId: string, sessionId: string) {
  const teacher = await requireTeacher(userId, institutionId);
  const session = await academicDb().ptmSession.findFirst({ where: { id: sessionId, institutionId, teacherId: teacher.id } });
  if (!session) throw new NotFoundError("Meeting not found");
  return { teacher, session };
}

export async function listSessionsForTeacher(userId: string, institutionId: string) {
  const teacher = await requireTeacher(userId, institutionId);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sessions = await academicDb().ptmSession.findMany({
    where: { institutionId, teacherId: teacher.id, date: { gte: new Date(`${istDateString(since)}T00:00:00.000Z`) } },
    orderBy: [{ date: "desc" }, { startMinute: "asc" }],
    include: {
      slots: {
        orderBy: { startMinute: "asc" },
        include: { student: { select: { id: true, userId: true, rollNo: true, division: { select: { name: true, standard: { select: { name: true } } } } } } },
      },
    },
  });
  const users = await resolveUsers(sessions.flatMap((s) => s.slots.map((sl) => sl.student?.userId)), { id: true, name: true });
  const today = istDateString();

  return sessions.map((s) => {
    const date = dateOnly(s.date);
    return {
      id: s.id,
      title: s.title,
      date,
      startMinute: s.startMinute,
      endMinute: s.endMinute,
      slotMinutes: s.slotMinutes,
      location: s.location,
      note: s.note,
      cancelled: s.cancelledAt != null,
      upcoming: date >= today,
      booked: s.slots.filter((sl) => sl.studentId).length,
      slots: s.slots.map((sl) => ({
        id: sl.id,
        startMinute: sl.startMinute,
        endMinute: sl.endMinute,
        student: sl.student
          ? {
              id: sl.student.id,
              name: users.get(sl.student.userId)?.name ?? "Student",
              rollNo: sl.student.rollNo,
              className: sl.student.division ? `${sl.student.division.standard.name} ${sl.student.division.name}` : null,
            }
          : null,
      })),
    };
  });
}

export async function cancelSession(userId: string, institutionId: string, sessionId: string): Promise<void> {
  const { session } = await requireOwnSession(userId, institutionId, sessionId);
  if (session.cancelledAt) return;
  const booked = await academicDb().ptmSlot.findMany({
    where: { sessionId, institutionId, studentId: { not: null } },
    select: { student: { select: { userId: true } } },
  });
  await academicDb().ptmSession.update({ where: { id: sessionId }, data: { cancelledAt: new Date() } });
  await notifyUsers({
    institutionId,
    userIds: booked.flatMap((b) => (b.student ? [b.student.userId] : [])),
    title: `Meeting cancelled: ${session.title}`,
    message: `The meeting on ${prettyDate(dateOnly(session.date))} was cancelled. Check Parent Mode for new slots.`,
    tag: "ptm",
    recipientType: "STUDENT",
    sentById: userId,
  });
}

export async function releaseSlot(userId: string, institutionId: string, slotId: string): Promise<void> {
  const teacher = await requireTeacher(userId, institutionId);
  const slot = await academicDb().ptmSlot.findFirst({
    where: { id: slotId, institutionId, session: { teacherId: teacher.id } },
    include: { session: true, student: { select: { userId: true } } },
  });
  if (!slot) throw new NotFoundError("Slot not found");
  if (!slot.studentId) return;
  await academicDb().ptmSlot.update({ where: { id: slotId }, data: { studentId: null, bookedByUserId: null, bookedAt: null } });
  if (slot.student) {
    await notifyUsers({
      institutionId,
      userIds: [slot.student.userId],
      title: "Your meeting slot was released",
      message: `The ${hhmm(slot.startMinute)} slot on ${prettyDate(dateOnly(slot.session.date))} was released by the teacher. Please book another.`,
      tag: "ptm",
      recipientType: "STUDENT",
      sentById: userId,
    });
  }
}

// ── Admin ────────────────────────────────────────────────────────────────────

export async function listSessionsForAdmin(institutionId: string) {
  const today = new Date(`${istDateString()}T00:00:00.000Z`);
  const sessions = await academicDb().ptmSession.findMany({
    where: { institutionId, date: { gte: today } },
    orderBy: [{ date: "asc" }, { startMinute: "asc" }],
    take: 200,
    include: { teacher: { select: { userId: true } }, slots: { select: { studentId: true } } },
  });
  const users = await resolveUsers(sessions.map((s) => s.teacher.userId), { id: true, name: true });
  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    teacherName: users.get(s.teacher.userId)?.name ?? "Teacher",
    date: dateOnly(s.date),
    startMinute: s.startMinute,
    endMinute: s.endMinute,
    location: s.location,
    cancelled: s.cancelledAt != null,
    totalSlots: s.slots.length,
    booked: s.slots.filter((sl) => sl.studentId).length,
  }));
}

// ── Parent (student login) ───────────────────────────────────────────────────

export async function listSessionsForStudent(userId: string, institutionId: string) {
  const student = await requireStudent(userId, institutionId);
  const teachers = await eligibleTeachersForStudent(institutionId, student.divisionId);
  if (teachers.length === 0) return { sessions: [] };

  const sessions = await academicDb().ptmSession.findMany({
    where: {
      institutionId,
      teacherId: { in: teachers.map((t) => t.id) },
      cancelledAt: null,
      date: { gte: new Date(`${istDateString()}T00:00:00.000Z`) },
    },
    orderBy: [{ date: "asc" }, { startMinute: "asc" }],
    include: { slots: { orderBy: { startMinute: "asc" } } },
    take: 50,
  });
  const users = await resolveUsers(teachers.map((t) => t.userId), { id: true, name: true });
  const teacherById = new Map(teachers.map((t) => [t.id, t]));
  const now = Date.now();

  return {
    sessions: sessions
      .map((s) => {
        const date = dateOnly(s.date);
        const t = teacherById.get(s.teacherId);
        const mine = s.slots.find((sl) => sl.studentId === student.id) ?? null;
        const slots = s.slots.map((sl) => ({
          id: sl.id,
          startMinute: sl.startMinute,
          endMinute: sl.endMinute,
          mine: sl.studentId === student.id,
          // "free" = open and still in the future; other parents' bookings are never exposed.
          free: sl.studentId == null && slotStart(date, sl.startMinute).getTime() > now,
        }));
        return {
          id: s.id,
          title: s.title,
          teacherName: t ? (users.get(t.userId)?.name ?? "Teacher") : "Teacher",
          teacherPrefix: t?.prefix ?? null,
          isClassTeacher: t?.isClassTeacher ?? false,
          subjects: t ? [...t.subjects].sort() : [],
          date,
          startMinute: s.startMinute,
          endMinute: s.endMinute,
          location: s.location,
          note: s.note,
          freeSlots: slots.filter((sl) => sl.free).length,
          myBooking: mine ? { slotId: mine.id, startMinute: mine.startMinute, endMinute: mine.endMinute, canCancel: slotStart(date, mine.startMinute).getTime() - now >= MIN_CANCEL_NOTICE_MS } : null,
          slots,
        };
      })
      .filter((s) => s.freeSlots > 0 || s.myBooking),
  };
}

export async function bookSlot(userId: string, institutionId: string, slotId: string) {
  const student = await requireStudent(userId, institutionId);
  if (student.status !== "ACTIVE") throw new ForbiddenError("This account cannot book meetings");

  const slot = await academicDb().ptmSlot.findFirst({ where: { id: slotId, institutionId }, include: { session: true } });
  if (!slot || slot.session.cancelledAt) throw new NotFoundError("Meeting slot not found");

  const teachers = await eligibleTeachersForStudent(institutionId, student.divisionId);
  const teacher = teachers.find((t) => t.id === slot.session.teacherId);
  if (!teacher) throw new ForbiddenError("You can only book meetings with your child's teachers");

  const date = dateOnly(slot.session.date);
  if (slotStart(date, slot.startMinute).getTime() <= Date.now()) throw new BadRequestError("That slot has already started");

  try {
    // Atomic claim: only succeeds while the slot is still open.
    const claimed = await academicDb().ptmSlot.updateMany({
      where: { id: slotId, institutionId, studentId: null },
      data: { studentId: student.id, bookedByUserId: userId, bookedAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictError("Someone just took that slot. Please pick another.");
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ConflictError("You already have a slot in this meeting. Cancel it first to pick another.");
    }
    throw err;
  }

  const users = await resolveUsers([userId], { id: true, name: true });
  await notifyUsers({
    institutionId,
    userIds: [teacher.userId],
    title: "Meeting slot booked",
    message: `Parent of ${users.get(userId)?.name ?? "a student"} booked ${hhmm(slot.startMinute)} on ${prettyDate(date)}.`,
    tag: "ptm",
    recipientType: "TEACHER",
    sentById: userId,
  });
  return { slotId, startMinute: slot.startMinute, endMinute: slot.endMinute, date };
}

export async function cancelBooking(userId: string, institutionId: string, slotId: string): Promise<void> {
  const student = await requireStudent(userId, institutionId);
  const slot = await academicDb().ptmSlot.findFirst({
    where: { id: slotId, institutionId, studentId: student.id },
    include: { session: { include: { teacher: { select: { userId: true } } } } },
  });
  if (!slot) throw new NotFoundError("Booking not found");

  const date = dateOnly(slot.session.date);
  if (slotStart(date, slot.startMinute).getTime() - Date.now() < MIN_CANCEL_NOTICE_MS) {
    throw new BadRequestError("Bookings can only be cancelled up to 2 hours before the slot. Please contact the teacher.");
  }
  await academicDb().ptmSlot.update({ where: { id: slotId }, data: { studentId: null, bookedByUserId: null, bookedAt: null } });

  const users = await resolveUsers([userId], { id: true, name: true });
  await notifyUsers({
    institutionId,
    userIds: [slot.session.teacher.userId],
    title: "Meeting booking cancelled",
    message: `Parent of ${users.get(userId)?.name ?? "a student"} cancelled ${hhmm(slot.startMinute)} on ${prettyDate(date)}.`,
    tag: "ptm",
    recipientType: "TEACHER",
    sentById: userId,
  });
}
