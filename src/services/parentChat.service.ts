// src/services/parentChat.service.ts
//
// Parent ↔ teacher chat. Parent Mode lives inside the student's own login (no
// separate parent account exists), so the "parent" side of every thread is the
// student account. A parent can only message teachers of the student's own
// division (class teacher + this year's subject teachers); teachers reply in
// the same thread and cannot start one. Admins can read any thread in their
// institution (parents and teachers are told this in the UI) and hide messages.
import { academicDb } from "../utils/academicContext";
import { getCurrentAcademicYear } from "../utils/academicYear";
import { resolveUsers } from "./userLookup.service";
import { dispatchPush } from "./pushNotification.service";
import { createNotification } from "./notification.service";
import { logAudit } from "./audit.service";
import { uploadAttachmentToR2, r2KeyFromUrl } from "./storage.service";
import { BadRequestError, ForbiddenError, NotFoundError, TooManyRequestsError } from "../utils/errors";

const MAX_MESSAGES_PER_MINUTE = 10;
const DEFAULT_PAGE = 100;
const HIDDEN_PLACEHOLDER = "";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatSettingsDTO {
  enabled: boolean;
  officeStart: string;
  officeEnd: string;
}

export interface ChatAttachment {
  url: string;
  type: "image" | "pdf";
  name: string;
}

export interface ChatMessageDTO {
  id: string;
  fromTeacher: boolean;
  text: string;
  attachment: ChatAttachment | null;
  hidden: boolean;
  /** True when the viewing user has reported this message. */
  reportedByMe: boolean;
  createdAt: string;
  readAt: string | null;
}

export interface MessageInput {
  text?: string;
  attachment?: ChatAttachment;
}

export interface MessagePage {
  messages: ChatMessageDTO[];
  /** True when the counterpart is outside office hours — shown to the sender. */
  outsideOfficeHours: boolean;
}

type MessageRow = {
  id: string;
  fromTeacher: boolean;
  text: string;
  attachmentUrl: string | null;
  attachmentType: string | null;
  attachmentName: string | null;
  hiddenAt: Date | null;
  reportedByUserId: string | null;
  createdAt: Date;
  readAt: Date | null;
};

const DEFAULT_SETTINGS: ChatSettingsDTO = { enabled: true, officeStart: "08:00", officeEnd: "18:00" };

// ── Office hours ─────────────────────────────────────────────────────────────

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function istMinutesOfDay(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** Office window in IST. Equal start/end means always open; start > end spans midnight. */
export function isWithinOfficeHours(settings: ChatSettingsDTO, now: Date = new Date()): boolean {
  const start = toMinutes(settings.officeStart);
  const end = toMinutes(settings.officeEnd);
  const current = istMinutesOfDay(now);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export async function getChatSettings(institutionId: string): Promise<ChatSettingsDTO> {
  const row = await academicDb().parentChatSettings.findUnique({ where: { institutionId } });
  if (!row) return { ...DEFAULT_SETTINGS };
  return { enabled: row.enabled, officeStart: row.officeStart, officeEnd: row.officeEnd };
}

export async function saveChatSettings(institutionId: string, input: ChatSettingsDTO): Promise<ChatSettingsDTO> {
  const row = await academicDb().parentChatSettings.upsert({
    where: { institutionId },
    create: { institutionId, ...input },
    update: input,
  });
  return { enabled: row.enabled, officeStart: row.officeStart, officeEnd: row.officeEnd };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function toAttachment(row: Pick<MessageRow, "attachmentUrl" | "attachmentType" | "attachmentName">): ChatAttachment | null {
  if (!row.attachmentUrl || (row.attachmentType !== "image" && row.attachmentType !== "pdf")) return null;
  return { url: row.attachmentUrl, type: row.attachmentType, name: row.attachmentName ?? "attachment" };
}

function toMessageDTO(row: MessageRow, viewerUserId?: string): ChatMessageDTO {
  const hidden = row.hiddenAt != null;
  return {
    id: row.id,
    fromTeacher: row.fromTeacher,
    text: hidden ? HIDDEN_PLACEHOLDER : row.text,
    attachment: hidden ? null : toAttachment(row),
    reportedByMe: !!viewerUserId && row.reportedByUserId === viewerUserId,
    hidden,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  };
}

function previewOf(text: string): string {
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}


type LastMessage = { threadId: string; text: string; attachmentType: string | null; hiddenAt: Date | null; fromTeacher: boolean; createdAt: Date };

function labelOf(text: string, attachmentType: string | null): string {
  if (text) return previewOf(text);
  return attachmentType === "pdf" ? "📄 PDF" : attachmentType === "image" ? "📷 Photo" : "";
}

const IMAGE_MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", test: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
  { mime: "application/pdf", test: (b) => b.subarray(0, 5).toString("ascii") === "%PDF-" },
];

/**
 * Parent-chat uploads accept photos and PDFs only. The type is decided by the
 * file's own bytes, never the client-supplied mimetype.
 */
export async function uploadChatAttachment(
  file: Buffer,
  originalName: string,
  institutionId: string
): Promise<ChatAttachment> {
  const detected = IMAGE_MAGIC.find((m) => m.test(file));
  if (!detected) throw new BadRequestError("Only photos (JPG, PNG, WebP) and PDFs can be attached");
  const result = await uploadAttachmentToR2(file, {
    originalName,
    contentType: detected.mime,
    institutionId,
    area: "parent-chat",
  });
  return { url: result.publicUrl, type: detected.mime === "application/pdf" ? "pdf" : "image", name: originalName.slice(0, 200) };
}

/** Only files uploaded through this institution's own parent-chat upload can be attached. */
function assertOwnAttachment(attachment: ChatAttachment, institutionId: string): void {
  const key = r2KeyFromUrl(attachment.url);
  if (!key || !key.startsWith(`institutions/${institutionId}/parent-chat/`)) {
    throw new BadRequestError("Invalid attachment");
  }
}

function resolveInput(input: MessageInput, institutionId: string): { text: string; attachment: ChatAttachment | null } {
  const text = (input.text ?? "").trim();
  if (!text && !input.attachment) throw new BadRequestError("Message cannot be empty");
  if (input.attachment) assertOwnAttachment(input.attachment, institutionId);
  return { text, attachment: input.attachment ?? null };
}

async function unreadByThread(threadIds: string[], institutionId: string, fromTeacher: boolean): Promise<Map<string, number>> {
  if (threadIds.length === 0) return new Map();
  const rows = await academicDb().parentChatMessage.groupBy({
    by: ["threadId"],
    where: { institutionId, threadId: { in: threadIds }, fromTeacher, readAt: null, hiddenAt: null },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.threadId, r._count._all] as [string, number]));
}

async function lastMessageByThread(threadIds: string[], institutionId: string): Promise<Map<string, LastMessage>> {
  if (threadIds.length === 0) return new Map();
  const rows: LastMessage[] = await academicDb().parentChatMessage.findMany({
    where: { institutionId, threadId: { in: threadIds } },
    orderBy: { createdAt: "desc" },
    distinct: ["threadId"],
    select: { threadId: true, text: true, attachmentType: true, hiddenAt: true, fromTeacher: true, createdAt: true },
  });
  return new Map(rows.map((r) => [r.threadId, r] as [string, LastMessage]));
}

function lastPreview(last: LastMessage | undefined) {
  if (!last || last.hiddenAt) return null;
  return { text: labelOf(last.text, last.attachmentType), fromTeacher: last.fromTeacher, createdAt: last.createdAt.toISOString() };
}

async function assertWithinRateLimit(institutionId: string, senderUserId: string): Promise<void> {
  const recent = await academicDb().parentChatMessage.count({
    where: { institutionId, senderUserId, createdAt: { gte: new Date(Date.now() - 60_000) } },
  });
  if (recent >= MAX_MESSAGES_PER_MINUTE) {
    throw new TooManyRequestsError("You are sending messages too quickly. Please wait a moment.");
  }
}

type PageQuery = { after?: Date; before?: Date; limit?: number };

async function fetchMessagePage(threadId: string, institutionId: string, viewerUserId: string, q: PageQuery): Promise<ChatMessageDTO[]> {
  const limit = Math.min(q.limit ?? DEFAULT_PAGE, DEFAULT_PAGE);
  if (q.after) {
    const rows = await academicDb().parentChatMessage.findMany({
      where: { threadId, institutionId, createdAt: { gt: q.after } },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    return rows.map((r) => toMessageDTO(r, viewerUserId));
  }
  const rows = await academicDb().parentChatMessage.findMany({
    where: { threadId, institutionId, ...(q.before ? { createdAt: { lt: q.before } } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.reverse().map((r) => toMessageDTO(r, viewerUserId));
}

// ── Student (parent) side ────────────────────────────────────────────────────

export async function requireStudent(userId: string, institutionId: string) {
  const student = await academicDb().student.findFirst({
    where: { userId, institutionId },
    select: { id: true, userId: true, divisionId: true, status: true },
  });
  if (!student) throw new NotFoundError("Student profile not found");
  return student;
}

/** Teachers a parent may message: class teacher + this year's subject teachers of the student's division. */
export async function eligibleTeachersForStudent(institutionId: string, divisionId: string | null) {
  if (!divisionId) return [];
  const db = academicDb();
  const year = await getCurrentAcademicYear(institutionId);
  const [division, assignments] = await Promise.all([
    db.division.findFirst({ where: { id: divisionId, institutionId }, select: { classTeacherId: true } }),
    db.divisionAssignment.findMany({
      where: { divisionId, institutionId, academicYearId: year.id },
      select: { teacherId: true, subject: { select: { name: true } } },
    }),
  ]);

  const roles = new Map<string, { isClassTeacher: boolean; subjects: Set<string> }>();
  const roleFor = (id: string) => {
    let r = roles.get(id);
    if (!r) roles.set(id, (r = { isClassTeacher: false, subjects: new Set() }));
    return r;
  };
  if (division?.classTeacherId) roleFor(division.classTeacherId).isClassTeacher = true;
  for (const a of assignments) {
    const r = roleFor(a.teacherId);
    if (a.subject?.name) r.subjects.add(a.subject.name);
  }
  if (roles.size === 0) return [];

  const teachers = await db.teacher.findMany({
    where: { id: { in: [...roles.keys()] }, institutionId, status: "ACTIVE" },
    select: { id: true, userId: true, prefix: true, avatarUrl: true },
  });
  return teachers.map((t) => ({ ...t, ...roleFor(t.id) }));
}

export async function listContactsForStudent(userId: string, institutionId: string) {
  const student = await requireStudent(userId, institutionId);
  const settings = await getChatSettings(institutionId);
  const teachers = await eligibleTeachersForStudent(institutionId, student.divisionId);
  const users = await resolveUsers(teachers.map((t) => t.userId), { id: true, name: true });

  const threads = await academicDb().parentChatThread.findMany({
    where: { studentId: student.id, institutionId, teacherId: { in: teachers.map((t) => t.id) } },
    select: { id: true, teacherId: true, lastMessageAt: true },
  });
  const threadByTeacher = new Map(threads.map((t) => [t.teacherId, t]));

  const threadIds = threads.map((t) => t.id);
  const [unreadMap, lastMap] = await Promise.all([
    unreadByThread(threadIds, institutionId, true),
    lastMessageByThread(threadIds, institutionId),
  ]);

  const contacts = teachers
    .map((t) => {
      const thread = threadByTeacher.get(t.id);
      return {
        teacherId: t.id,
        name: users.get(t.userId)?.name ?? "Teacher",
        prefix: t.prefix,
        avatarUrl: t.avatarUrl,
        isClassTeacher: t.isClassTeacher,
        subjects: [...t.subjects].sort(),
        unread: thread ? (unreadMap.get(thread.id) ?? 0) : 0,
        lastMessage: lastPreview(thread ? lastMap.get(thread.id) : undefined),
        lastMessageAt: thread ? thread.lastMessageAt.toISOString() : null,
      };
    })
    .sort((a, b) => {
      if (a.lastMessageAt && b.lastMessageAt) return b.lastMessageAt.localeCompare(a.lastMessageAt);
      if (a.lastMessageAt) return -1;
      if (b.lastMessageAt) return 1;
      return Number(b.isClassTeacher) - Number(a.isClassTeacher) || a.name.localeCompare(b.name);
    });

  return {
    settings: { ...settings, withinOfficeHours: isWithinOfficeHours(settings) },
    contacts,
  };
}

async function requireEligibleTeacher(institutionId: string, divisionId: string | null, teacherId: string) {
  const teachers = await eligibleTeachersForStudent(institutionId, divisionId);
  const teacher = teachers.find((t) => t.id === teacherId);
  if (!teacher) throw new ForbiddenError("You can only message teachers of your own class");
  return teacher;
}

export async function getMessagesForStudent(userId: string, institutionId: string, teacherId: string, q: PageQuery) {
  const student = await requireStudent(userId, institutionId);
  const thread = await academicDb().parentChatThread.findUnique({
    where: { studentId_teacherId: { studentId: student.id, teacherId } },
  });
  if (!thread || thread.institutionId !== institutionId) return { messages: [] as ChatMessageDTO[] };
  return { messages: await fetchMessagePage(thread.id, institutionId, userId, q) };
}

export async function sendMessageFromStudent(userId: string, institutionId: string, teacherId: string, input: MessageInput) {
  const { text, attachment } = resolveInput(input, institutionId);
  const student = await requireStudent(userId, institutionId);
  if (student.status !== "ACTIVE") throw new ForbiddenError("Messaging is unavailable for this account");

  const settings = await getChatSettings(institutionId);
  if (!settings.enabled) throw new ForbiddenError("Parent-teacher chat is turned off by your school");

  const teacher = await requireEligibleTeacher(institutionId, student.divisionId, teacherId);
  await assertWithinRateLimit(institutionId, userId);

  const db = academicDb();
  const message = await db.$transaction(async (tx) => {
    const thread = await tx.parentChatThread.upsert({
      where: { studentId_teacherId: { studentId: student.id, teacherId } },
      create: { institutionId, studentId: student.id, teacherId },
      update: {},
    });
    if (thread.institutionId !== institutionId) throw new ForbiddenError("Thread does not belong to this institution");
    const created = await tx.parentChatMessage.create({
      data: {
        institutionId, threadId: thread.id, fromTeacher: false, senderUserId: userId, text,
        attachmentUrl: attachment?.url, attachmentType: attachment?.type, attachmentName: attachment?.name,
      },
    });
    await tx.parentChatThread.update({ where: { id: thread.id }, data: { lastMessageAt: created.createdAt } });
    return created;
  });

  const withinOfficeHours = isWithinOfficeHours(settings);
  if (withinOfficeHours) {
    const users = await resolveUsers([userId], { id: true, name: true });
    dispatchPush(
      { id: message.threadId, title: `Parent of ${users.get(userId)?.name ?? "a student"}`, message: labelOf(text, attachment?.type ?? null), tag: "parent_chat" },
      [{ userId: teacher.userId, institutionId }]
    ).catch((err: Error) => console.error("⚠️  Parent chat push failed (non-blocking):", err.message));
  }

  return { message: toMessageDTO(message, userId), outsideOfficeHours: !withinOfficeHours };
}

export async function markReadForStudent(userId: string, institutionId: string, teacherId: string): Promise<void> {
  const student = await requireStudent(userId, institutionId);
  const thread = await academicDb().parentChatThread.findUnique({
    where: { studentId_teacherId: { studentId: student.id, teacherId } },
    select: { id: true, institutionId: true },
  });
  if (!thread || thread.institutionId !== institutionId) return;
  await academicDb().parentChatMessage.updateMany({
    where: { threadId: thread.id, institutionId, fromTeacher: true, readAt: null },
    data: { readAt: new Date() },
  });
}

export async function unreadCountForStudent(userId: string, institutionId: string): Promise<number> {
  const student = await academicDb().student.findFirst({ where: { userId, institutionId }, select: { id: true } });
  if (!student) return 0;
  return academicDb().parentChatMessage.count({
    where: { institutionId, thread: { studentId: student.id }, fromTeacher: true, readAt: null, hiddenAt: null },
  });
}

// ── Teacher side ─────────────────────────────────────────────────────────────

export async function requireTeacher(userId: string, institutionId: string) {
  const teacher = await academicDb().teacher.findFirst({
    where: { userId, institutionId },
    select: { id: true, userId: true, status: true },
  });
  if (!teacher) throw new NotFoundError("Teacher profile not found");
  return teacher;
}

async function requireTeacherThread(teacherId: string, institutionId: string, threadId: string) {
  const thread = await academicDb().parentChatThread.findFirst({ where: { id: threadId, teacherId, institutionId } });
  if (!thread) throw new NotFoundError("Conversation not found");
  return thread;
}

export async function listThreadsForTeacher(userId: string, institutionId: string) {
  const teacher = await requireTeacher(userId, institutionId);
  const db = academicDb();
  const threads = await db.parentChatThread.findMany({
    where: { teacherId: teacher.id, institutionId },
    orderBy: { lastMessageAt: "desc" },
    take: 200,
    include: {
      student: {
        select: {
          id: true,
          userId: true,
          rollNo: true,
          division: { select: { name: true, standard: { select: { name: true } } } },
        },
      },
    },
  });
  const ids = threads.map((t) => t.id);
  const [users, unreadMap, lastMap] = await Promise.all([
    resolveUsers(threads.map((t) => t.student.userId), { id: true, name: true }),
    unreadByThread(ids, institutionId, false),
    lastMessageByThread(ids, institutionId),
  ]);

  const settings = await getChatSettings(institutionId);
  return {
    settings: { ...settings, withinOfficeHours: isWithinOfficeHours(settings) },
    threads: threads.map((t) => {
      return {
        id: t.id,
        studentName: users.get(t.student.userId)?.name ?? "Student",
        rollNo: t.student.rollNo,
        className: t.student.division ? `${t.student.division.standard.name} ${t.student.division.name}` : null,
        unread: unreadMap.get(t.id) ?? 0,
        lastMessage: lastPreview(lastMap.get(t.id)),
        lastMessageAt: t.lastMessageAt.toISOString(),
      };
    }),
  };
}

export async function getMessagesForTeacher(userId: string, institutionId: string, threadId: string, q: PageQuery) {
  const teacher = await requireTeacher(userId, institutionId);
  await requireTeacherThread(teacher.id, institutionId, threadId);
  return { messages: await fetchMessagePage(threadId, institutionId, userId, q) };
}

export async function sendMessageFromTeacher(userId: string, institutionId: string, threadId: string, input: MessageInput) {
  const { text, attachment } = resolveInput(input, institutionId);
  const teacher = await requireTeacher(userId, institutionId);
  if (teacher.status !== "ACTIVE") throw new ForbiddenError("Messaging is unavailable for this account");
  const thread = await requireTeacherThread(teacher.id, institutionId, threadId);

  const settings = await getChatSettings(institutionId);
  if (!settings.enabled) throw new ForbiddenError("Parent-teacher chat is turned off by your school");
  await assertWithinRateLimit(institutionId, userId);

  const student = await academicDb().student.findFirst({ where: { id: thread.studentId, institutionId }, select: { userId: true } });
  if (!student) throw new NotFoundError("Student not found");

  const message = await academicDb().$transaction(async (tx) => {
    const created = await tx.parentChatMessage.create({
      data: {
        institutionId, threadId, fromTeacher: true, senderUserId: userId, text,
        attachmentUrl: attachment?.url, attachmentType: attachment?.type, attachmentName: attachment?.name,
      },
    });
    await tx.parentChatThread.update({ where: { id: threadId }, data: { lastMessageAt: created.createdAt } });
    return created;
  });

  const users = await resolveUsers([userId], { id: true, name: true });
  dispatchPush(
    { id: threadId, title: users.get(userId)?.name ?? "Your teacher", message: labelOf(text, attachment?.type ?? null), tag: "parent_chat" },
    [{ userId: student.userId, institutionId }]
  ).catch((err: Error) => console.error("⚠️  Parent chat push failed (non-blocking):", err.message));

  return { message: toMessageDTO(message, userId) };
}

export async function markReadForTeacher(userId: string, institutionId: string, threadId: string): Promise<void> {
  const teacher = await requireTeacher(userId, institutionId);
  await requireTeacherThread(teacher.id, institutionId, threadId);
  await academicDb().parentChatMessage.updateMany({
    where: { threadId, institutionId, fromTeacher: false, readAt: null },
    data: { readAt: new Date() },
  });
}

export async function unreadCountForTeacher(userId: string, institutionId: string): Promise<number> {
  const teacher = await academicDb().teacher.findFirst({ where: { userId, institutionId }, select: { id: true } });
  if (!teacher) return 0;
  return academicDb().parentChatMessage.count({
    where: { institutionId, thread: { teacherId: teacher.id }, fromTeacher: false, readAt: null, hiddenAt: null },
  });
}

// ── Admin side ───────────────────────────────────────────────────────────────

export async function listThreadsForAdmin(institutionId: string) {
  const db = academicDb();
  const threads = await db.parentChatThread.findMany({
    where: { institutionId },
    orderBy: { lastMessageAt: "desc" },
    take: 200,
    include: {
      student: { select: { userId: true, rollNo: true, division: { select: { name: true, standard: { select: { name: true } } } } } },
      teacher: { select: { userId: true } },
      _count: { select: { messages: true } },
    },
  });
  const [users, reported] = await Promise.all([
    resolveUsers(threads.flatMap((t) => [t.student.userId, t.teacher.userId]), { id: true, name: true }),
    threads.length
      ? db.parentChatMessage.groupBy({
          by: ["threadId"],
          where: { institutionId, threadId: { in: threads.map((t) => t.id) }, reportedAt: { not: null }, hiddenAt: null },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ threadId: string; _count: { _all: number } }>),
  ]);
  const reportedByThread = new Map(reported.map((r) => [r.threadId, r._count._all] as [string, number]));
  const rows = threads.map((t) => ({
    id: t.id,
    studentName: users.get(t.student.userId)?.name ?? "Student",
    rollNo: t.student.rollNo,
    className: t.student.division ? `${t.student.division.standard.name} ${t.student.division.name}` : null,
    teacherName: users.get(t.teacher.userId)?.name ?? "Teacher",
    messageCount: t._count.messages,
    reportedCount: reportedByThread.get(t.id) ?? 0,
    lastMessageAt: t.lastMessageAt.toISOString(),
  }));
  // Threads with open reports first, then newest activity.
  return rows.sort((a, b) => Number(b.reportedCount > 0) - Number(a.reportedCount > 0) || b.lastMessageAt.localeCompare(a.lastMessageAt));
}

export async function getThreadForAdmin(institutionId: string, threadId: string) {
  const thread = await academicDb().parentChatThread.findFirst({
    where: { id: threadId, institutionId },
    include: {
      student: { select: { userId: true } },
      teacher: { select: { userId: true } },
    },
  });
  if (!thread) throw new NotFoundError("Conversation not found");
  const [users, rows] = await Promise.all([
    resolveUsers([thread.student.userId, thread.teacher.userId], { id: true, name: true }),
    academicDb().parentChatMessage.findMany({
      where: { threadId, institutionId },
      orderBy: { createdAt: "asc" },
      take: 500,
    }),
  ]);
  return {
    id: thread.id,
    studentName: users.get(thread.student.userId)?.name ?? "Student",
    teacherName: users.get(thread.teacher.userId)?.name ?? "Teacher",
    // Admins see the original text of hidden messages (for moderation review).
    messages: rows.map((r) => ({
      ...toMessageDTO(r),
      text: r.text,
      attachment: toAttachment(r),
      reportedAt: r.reportedAt ? r.reportedAt.toISOString() : null,
      reportReason: r.reportReason,
    })),
  };
}

/** Reported messages an admin has not yet hidden — drives the badge in the admin nav. */
export async function reportedCountForAdmin(institutionId: string): Promise<number> {
  return academicDb().parentChatMessage.count({ where: { institutionId, reportedAt: { not: null }, hiddenAt: null } });
}

export async function hideMessage(institutionId: string, messageId: string, adminUserId: string): Promise<void> {
  const message = await academicDb().parentChatMessage.findFirst({ where: { id: messageId, institutionId }, select: { id: true } });
  if (!message) throw new NotFoundError("Message not found");
  await academicDb().parentChatMessage.update({
    where: { id: messageId },
    data: { hiddenAt: new Date(), hiddenByUserId: adminUserId },
  });
}

/**
 * A parent or teacher flags a message from the OTHER side of the conversation.
 * Admins are notified and the thread floats to the top of their list.
 */
export async function reportMessage(
  userId: string,
  institutionId: string,
  messageId: string,
  reporter: "student" | "teacher",
  reason?: string
): Promise<void> {
  const message = await academicDb().parentChatMessage.findFirst({
    where: { id: messageId, institutionId },
    include: { thread: { select: { id: true, student: { select: { userId: true } }, teacher: { select: { userId: true } } } } },
  });
  if (!message) throw new NotFoundError("Message not found");

  const isParticipant = reporter === "student" ? message.thread.student.userId === userId : message.thread.teacher.userId === userId;
  if (!isParticipant) throw new NotFoundError("Message not found");
  if (message.fromTeacher === (reporter === "teacher")) throw new BadRequestError("You can only report messages sent to you");
  if (message.reportedAt) return;

  await academicDb().parentChatMessage.update({
    where: { id: messageId },
    data: { reportedAt: new Date(), reportedByUserId: userId, reportReason: reason?.trim() || null },
  });

  logAudit("PARENT_CHAT_MESSAGE_REPORTED", {
    userId,
    actorRole: reporter === "student" ? "STUDENT" : "TEACHER",
    institutionId,
    details: `message ${messageId} in thread ${message.thread.id}`,
    category: "SECURITY",
    severity: "WARNING",
  });
  createNotification({
    title: "Parent chat message reported",
    message: "A message in a parent–teacher conversation was reported. Review it in Insights → Parent Chat.",
    tag: "parent_chat_report",
    recipientType: "ADMIN",
    recipients: [{ institutionId }],
    adminOnly: true,
  }).catch((err: Error) => console.error("⚠️  Report notification failed (non-blocking):", err.message));
}

export function assertValidOfficeHours(settings: ChatSettingsDTO): void {
  const ok = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!ok.test(settings.officeStart) || !ok.test(settings.officeEnd)) {
    throw new BadRequestError("Office hours must be in HH:mm format");
  }
}
