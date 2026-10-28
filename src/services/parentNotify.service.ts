// src/services/parentNotify.service.ts
//
// In-app notification + push to a list of users (students/teachers). Used by
// parent forms and the PTM scheduler. Never throws — a failed notification must
// not undo the write that triggered it.
import { createNotification } from "./notification.service";

export async function notifyUsers(params: {
  institutionId: string;
  userIds: string[];
  title: string;
  message: string;
  tag: string;
  recipientType: "STUDENT" | "TEACHER";
  sentById?: string;
}): Promise<void> {
  const { institutionId, userIds, title, message, tag, recipientType, sentById } = params;
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  try {
    await createNotification({
      title,
      message,
      tag,
      recipientType,
      sentById,
      recipients: unique.map((userId) => ({ institutionId, userId })),
    });
  } catch (err) {
    console.error("⚠️  Parent notification failed (non-blocking):", (err as Error).message);
  }
}
