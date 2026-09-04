// ── Jarvis (AI School PA) chat history — cross-device persistence ──────────
// Keyed to the logged-in userId (not a browser/device), so the same admin
// sees the same conversation regardless of which laptop/browser they log in
// from. History is capped on read (not deleted on write) so it never grows
// unbounded in a single query, and never silently drops a message the user
// hasn't seen yet just because more came in later on another device.
import { prisma } from "../utils/prisma";

const HISTORY_LIMIT = 60; // messages, not turns — matches ~30 back-and-forths

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export async function getChatHistory(userId: string): Promise<ChatHistoryMessage[]> {
  const rows = await prisma.aiChatMessage.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, content: true, createdAt: true },
  });
  // Fetched newest-first (so the cap keeps the most recent messages), then
  // flipped back to chronological order for display.
  return rows
    .reverse()
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content, ts: r.createdAt.getTime() }));
}

export async function appendChatMessages(
  userId: string,
  institutionId: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>
): Promise<void> {
  if (messages.length === 0) return;
  await prisma.aiChatMessage.createMany({
    data: messages.map((m) => ({ userId, institutionId, role: m.role, content: m.content })),
  });
}

export async function clearChatHistory(userId: string): Promise<void> {
  await prisma.aiChatMessage.deleteMany({ where: { userId } });
}
