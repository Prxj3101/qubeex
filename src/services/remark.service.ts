// src/services/remark.service.ts
import { academicDb } from "../utils/academicContext";
import { resolveUsers } from "./userLookup.service";
import { CreateRemarkInput, ReviewRemarkInput, EditRemarkInput, RemarkAttachment } from "./remark.schema";

export interface StudentRemarkDTO {
  id: string;
  studentId: string;
  studentName: string;
  divisionId: string | null;
  standardId: string | null;
  className?: string;
  type: "yellow" | "red";
  severity: "low" | "medium" | "high";
  category: string;
  title: string;
  detail: string;
  date: string;
  subject?: string;
  reportedBy: string;
  role: string;
  status: "open" | "under_review" | "resolved" | "rejected" | "appealed";
  actionTaken?: string;
  attachments: RemarkAttachment[];
  assignedToName?: string;
  reviewRemark?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  /** True if the current viewer (passed in at read time) may action this report. */
  canReview: boolean;
  /** True only for the person who originally filed this report — edit is not admin-wide. */
  canEdit: boolean;
}

type RemarkRow = {
  id: string;
  studentId: string;
  student: { studentId: string; userId: string; divisionId: string | null; standardId: string | null; division: { name: string } | null };
  type: "YELLOW" | "RED";
  severity: "LOW" | "MEDIUM" | "HIGH";
  category: string;
  title: string;
  detail: string;
  createdAt: Date;
  subject: string | null;
  status: "ACTIVE" | "UNDER_REVIEW" | "RESOLVED" | "REJECTED" | "APPEALED";
  actionTaken: string | null;
  attachments: unknown;
  reportedByUserId: string;
  reportedByRole: string;
  assignedToUserId: string | null;
  reviewRemark: string | null;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
};

// User names live in the central DB (Student/StudentRemark may be in a tenant
// DB under BYOD), so they are stitched in via resolveUsers rather than joined.
type UserNames = Map<string, { name: string | null }>;

function remarkUserIds(row: RemarkRow): (string | null | undefined)[] {
  return [row.student.userId, row.reportedByUserId, row.assignedToUserId, row.reviewedByUserId];
}

// `attachments` is a Json column — parse defensively rather than trust the
// shape, since old rows or bad writes could leave it as null/malformed.
function parseAttachments(value: unknown): RemarkAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (a): a is RemarkAttachment =>
      !!a && typeof a === "object" && typeof (a as RemarkAttachment).url === "string" &&
      typeof (a as RemarkAttachment).name === "string" && typeof (a as RemarkAttachment).type === "string"
  );
}

function formatRemarkDate(d: Date): string {
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" });
  const year = d.getFullYear();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${day} ${month} ${year}, ${time}`;
}

const STATUS_MAP: Record<RemarkRow["status"], StudentRemarkDTO["status"]> = {
  ACTIVE: "open",
  UNDER_REVIEW: "under_review",
  RESOLVED: "resolved",
  REJECTED: "rejected",
  APPEALED: "appealed",
};

function toDTO(row: RemarkRow, viewer: { userId: string; role: string }, users: UserNames): StudentRemarkDTO {
  const isAdmin = viewer.role === "ADMIN" || viewer.role === "SUB_ADMIN";
  const isAssignee = row.assignedToUserId === viewer.userId;
  const isActionable = row.status === "ACTIVE" || row.status === "UNDER_REVIEW";

  return {
    id: row.id,
    studentId: row.studentId,
    studentName: users.get(row.student.userId)?.name ?? "Unknown",
    divisionId: row.student.divisionId,
    standardId: row.student.standardId,
    className: row.student.division?.name,
    type: row.type === "YELLOW" ? "yellow" : "red",
    severity: row.severity.toLowerCase() as StudentRemarkDTO["severity"],
    category: row.category,
    title: row.title,
    detail: row.detail,
    date: formatRemarkDate(row.createdAt),
    subject: row.subject ?? undefined,
    reportedBy: users.get(row.reportedByUserId)?.name ?? "Unknown",
    role: row.reportedByRole,
    status: STATUS_MAP[row.status],
    actionTaken: row.actionTaken ?? undefined,
    attachments: parseAttachments(row.attachments),
    assignedToName: (row.assignedToUserId ? users.get(row.assignedToUserId)?.name : undefined) ?? undefined,
    reviewRemark: row.reviewRemark ?? undefined,
    reviewedBy: (row.reviewedByUserId ? users.get(row.reviewedByUserId)?.name : undefined) ?? undefined,
    reviewedAt: row.reviewedAt ? formatRemarkDate(row.reviewedAt) : undefined,
    canReview: isActionable && (isAdmin || isAssignee),
    canEdit: row.reportedByUserId === viewer.userId,
  };
}

// No `user` relations — Student/StudentRemark may live in a tenant DB with no
// User table. userId scalars are selected and resolved via resolveUsers.
const REMARK_INCLUDE = {
  student: { select: { studentId: true, userId: true, divisionId: true, standardId: true, division: { select: { name: true } } } },
} as const;

export async function createStudentRemark(params: {
  institutionId: string;
  studentId: string;
  divisionId: string;
  reportedByUserId: string;
  reportedByRole: "Faculty" | "Admin";
  viewer: { userId: string; role: string };
  data: CreateRemarkInput;
}): Promise<StudentRemarkDTO> {
  const { institutionId, studentId, divisionId, reportedByUserId, reportedByRole, viewer, data } = params;

  // Fixed routing rule: every report is auto-assigned to the student's class
  // teacher (the DivisionAssignment with subjectId = null) at creation time.
  // Admin can review any report regardless of assignment.
  const classTeacherAssignment = await academicDb().divisionAssignment.findFirst({
    where: { divisionId, institutionId, subjectId: null },
    select: { teacher: { select: { userId: true } } },
  });
  const assignedToUserId = classTeacherAssignment?.teacher.userId ?? null;

  const type = data.type;

  const row = await academicDb().studentRemark.create({
    data: {
      institutionId,
      studentId,
      reportedByUserId,
      reportedByRole,
      assignedToUserId,
      type,
      severity: data.severity,
      category: data.category,
      title: data.title,
      detail: data.detail,
      subject: data.subject,
      actionTaken: data.actionTaken,
      attachments: data.attachments ?? [],
    },
    include: REMARK_INCLUDE,
  });

  const users = await resolveUsers(remarkUserIds(row), { id: true, name: true });
  return toDTO(row, viewer, users);
}

export async function listStudentRemarks(
  studentId: string,
  institutionId: string,
  viewer: { userId: string; role: string }
): Promise<StudentRemarkDTO[]> {
  const rows = await academicDb().studentRemark.findMany({
    where: { studentId, institutionId },
    orderBy: { createdAt: "desc" },
    include: REMARK_INCLUDE,
  });

  const users = await resolveUsers(rows.flatMap(remarkUserIds), { id: true, name: true });
  return rows.map((r) => toDTO(r, viewer, users));
}

/** Reports assigned to (or, for admins, all reports for) the given institution, for a reviewer inbox. */
export async function listAssignedRemarks(
  institutionId: string,
  viewer: { userId: string; role: string }
): Promise<StudentRemarkDTO[]> {
  const isAdmin = viewer.role === "ADMIN" || viewer.role === "SUB_ADMIN";
  const rows = await academicDb().studentRemark.findMany({
    where: {
      institutionId,
      ...(isAdmin ? {} : { assignedToUserId: viewer.userId }),
    },
    orderBy: [{ createdAt: "desc" }],
    include: REMARK_INCLUDE,
  });

  const users = await resolveUsers(rows.flatMap(remarkUserIds), { id: true, name: true });
  return rows.map((r) => toDTO(r, viewer, users));
}

/** Reports a given user has personally submitted, for a "my reports" history view. */
export async function listSubmittedRemarks(
  institutionId: string,
  viewer: { userId: string; role: string }
): Promise<StudentRemarkDTO[]> {
  const rows = await academicDb().studentRemark.findMany({
    where: { institutionId, reportedByUserId: viewer.userId },
    orderBy: { createdAt: "desc" },
    include: REMARK_INCLUDE,
  });

  const users = await resolveUsers(rows.flatMap(remarkUserIds), { id: true, name: true });
  return rows.map((r) => toDTO(r, viewer, users));
}

/** Admin-only: permanently deletes a report/remark card. Removes it from every
 * view that reads it (admin reports inbox, teacher's assigned reports, and the
 * student's own Flags & Warnings board) since they all read from the same row. */
export async function deleteStudentRemark(params: {
  remarkId: string;
  institutionId: string;
}): Promise<void> {
  const { remarkId, institutionId } = params;

  const existing = await academicDb().studentRemark.findFirst({
    where: { id: remarkId, institutionId },
    select: { id: true },
  });
  if (!existing) throw { status: 404, message: "Report not found" };

  await academicDb().studentRemark.delete({ where: { id: remarkId } });
}

/** Only the original reporter can edit their own card's content — this is
 * intentionally NOT admin-wide, unlike delete. Editing what someone else
 * personally reported would misattribute their account of events. */
export async function editStudentRemark(params: {
  remarkId: string;
  institutionId: string;
  viewer: { userId: string; role: string };
  data: EditRemarkInput;
}): Promise<StudentRemarkDTO> {
  const { remarkId, institutionId, viewer, data } = params;

  const existing = await academicDb().studentRemark.findFirst({
    where: { id: remarkId, institutionId },
    select: { reportedByUserId: true },
  });
  if (!existing) throw { status: 404, message: "Report not found" };
  if (existing.reportedByUserId !== viewer.userId) {
    throw { status: 403, message: "Only the person who filed this report can edit it" };
  }

  const row = await academicDb().studentRemark.update({
    where: { id: remarkId },
    data: {
      ...(data.type !== undefined && { type: data.type }),
      ...(data.category !== undefined && { category: data.category }),
      ...(data.title !== undefined && { title: data.title }),
      ...(data.detail !== undefined && { detail: data.detail }),
      ...(data.subject !== undefined && { subject: data.subject || null }),
      ...(data.actionTaken !== undefined && { actionTaken: data.actionTaken || null }),
      ...(data.attachments !== undefined && { attachments: data.attachments }),
    },
    include: REMARK_INCLUDE,
  });

  const users = await resolveUsers(remarkUserIds(row), { id: true, name: true });
  return toDTO(row, viewer, users);
}

export async function reviewStudentRemark(params: {
  remarkId: string;
  institutionId: string;
  viewer: { userId: string; role: string };
  data: ReviewRemarkInput;
}): Promise<StudentRemarkDTO> {
  const { remarkId, institutionId, viewer, data } = params;

  const existing = await academicDb().studentRemark.findFirst({
    where: { id: remarkId, institutionId },
    select: { assignedToUserId: true, status: true },
  });
  if (!existing) throw { status: 404, message: "Report not found" };

  const isAdmin = viewer.role === "ADMIN" || viewer.role === "SUB_ADMIN";
  const isAssignee = existing.assignedToUserId === viewer.userId;
  if (!isAdmin && !isAssignee) {
    throw { status: 403, message: "Only the assigned reviewer or an admin can action this report" };
  }
  if (existing.status === "RESOLVED" || existing.status === "REJECTED") {
    throw { status: 409, message: "This report has already been closed" };
  }

  const row = await academicDb().studentRemark.update({
    where: { id: remarkId },
    data: {
      status: data.status,
      reviewRemark: data.reviewRemark,
      reviewedByUserId: viewer.userId,
      reviewedAt: new Date(),
    },
    include: REMARK_INCLUDE,
  });

  const users = await resolveUsers(remarkUserIds(row), { id: true, name: true });
  return toDTO(row, viewer, users);
}
