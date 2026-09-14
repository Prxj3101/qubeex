import { prisma } from "../utils/prisma";
import { dispatchPush } from "./pushNotification.service";

type NotificationRecipientInput = { institutionId: string; userId?: string };

/**
 * A recipient row with userId=null is read by notifications.controller.ts's
 * listNotifications as "visible to every user in this institution" — ANY
 * role, since its query is `OR: [{ userId: null }, { userId }]` with no role
 * filter. That's correct for genuinely institution-wide notices, but every
 * existing caller using the institutionId-only shape (billing, trial,
 * ticket-reply, superadmin broadcasts) is actually admin-facing content
 * ("contact your administrator", "mark payment received") that leaked to
 * teachers/students once they got notification UI. `adminOnly: true` expands
 * such a recipient into one row per ADMIN/SUB_ADMIN user of that institution
 * instead, so the broadcast-style OR clause simply can't match a teacher or
 * student.
 */
export async function createNotification(data: {
  title: string;
  message: string;
  tag: string;
  recipientType: string;
  sentById?: string;
  recipients?: NotificationRecipientInput[];
  adminOnly?: boolean;
}) {
  let recipients = data.recipients ?? [];

  if (data.adminOnly && recipients.length > 0) {
    const broadcastInstitutionIds = [...new Set(recipients.filter((r) => !r.userId).map((r) => r.institutionId))];
    const alreadyTargeted = recipients.filter((r) => r.userId);

    if (broadcastInstitutionIds.length > 0) {
      const admins = await prisma.user.findMany({
        where: { institutionId: { in: broadcastInstitutionIds }, role: { in: ["ADMIN", "SUB_ADMIN"] } },
        select: { id: true, institutionId: true },
      });
      recipients = [
        ...alreadyTargeted,
        ...admins.map((a) => ({ institutionId: a.institutionId as string, userId: a.id })),
      ];
    }
  }

  const notification = await prisma.notification.create({
    data: {
      title: data.title,
      message: data.message,
      tag: data.tag,
      recipientType: data.recipientType,
      deliveredTo: recipients.length,
      sentById: data.sentById,
      recipients: recipients.length > 0 ? { create: recipients } : undefined,
    },
    include: { recipients: true },
  });

  dispatchPush(
    { id: notification.id, title: notification.title, message: notification.message, tag: notification.tag },
    notification.recipients.map((r) => ({ userId: r.userId, institutionId: r.institutionId }))
  ).catch((err) => console.error("⚠️  Push dispatch failed (non-blocking):", err.message));

  return notification;
}
