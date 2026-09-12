import { prisma } from "../utils/prisma";
import { dispatchPush } from "./pushNotification.service";

type NotificationRecipientInput = { institutionId: string; userId?: string };

/**
 * Single entry point for creating a Notification + its NotificationRecipient
 * rows. Every caller that used to hand-roll `prisma.notification.create`
 * (crons, payroll, superadmin broadcasts/ticket replies) now goes through
 * this so every notification also fires an Expo push — one place to keep
 * that in sync, instead of duplicating the push call at each call site.
 */
export async function createNotification(data: {
  title: string;
  message: string;
  tag: string;
  recipientType: string;
  sentById?: string;
  recipients?: NotificationRecipientInput[];
}) {
  const recipients = data.recipients ?? [];

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
