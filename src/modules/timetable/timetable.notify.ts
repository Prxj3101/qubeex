import { academicDb } from "../../utils/academicContext";
import { createNotification } from "../../services/notification.service";
import { logAudit } from "../../services/audit.service";

export interface Actor {
  userId: string;
  role: string;
  institutionId: string;
  ip?: string;
}

export function audit(actor: Actor, action: string, details: string, metadata?: Record<string, string | number | boolean | null | undefined | string[]>) {
  logAudit(action, {
    userId: actor.userId,
    actorRole: actor.role,
    institutionId: actor.institutionId,
    ip: actor.ip,
    details,
    metadata: metadata as never,
  });
}

/** userIds of the division's students for the given academic year (via enrollment, not the live division). */
export async function divisionStudentUserIds(institutionId: string, divisionId: string, academicYearId: string): Promise<string[]> {
  const db = academicDb();
  const enrollments = await db.studentEnrollment.findMany({
    where: { institutionId, divisionId, academicYearId, status: "ACTIVE" },
    select: { studentId: true },
  });
  if (!enrollments.length) return [];
  const students = await db.student.findMany({
    where: { id: { in: enrollments.map((e) => e.studentId) }, institutionId },
    select: { userId: true },
  });
  return students.map((s) => s.userId);
}

export async function teacherUserIds(institutionId: string, teacherIds: string[]): Promise<string[]> {
  const ids = [...new Set(teacherIds.filter(Boolean))];
  if (!ids.length) return [];
  const rows = await academicDb().teacher.findMany({ where: { id: { in: ids }, institutionId }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

/**
 * Fire-and-forget notification through the existing QubeEx notification system.
 * Never throws — a failed notification must not fail the timetable change.
 */
export function notifyUsers(params: {
  institutionId: string;
  userIds: string[];
  title: string;
  message: string;
  tag: string;
  sentById?: string;
}): void {
  const userIds = [...new Set(params.userIds)];
  if (!userIds.length) return;
  createNotification({
    title: params.title,
    message: params.message,
    tag: params.tag,
    recipientType: "SPECIFIC",
    sentById: params.sentById,
    recipients: userIds.map((userId) => ({ institutionId: params.institutionId, userId })),
  }).catch((err) => console.error("Timetable notification failed (non-blocking):", err instanceof Error ? err.message : err));
}
