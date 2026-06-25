import { redis } from "../utils/redis";

const PRESENCE_TTL = 60; // seconds — key expires 60s after last heartbeat

export async function setPresence(userId: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(`presence:${userId}`, "1", "EX", PRESENCE_TTL);
  } catch {
    // Non-critical — never throw
  }
}

export async function getPresenceBatch(
  userIds: string[]
): Promise<Record<string, boolean>> {
  if (!redis || userIds.length === 0) return {};
  try {
    const keys = userIds.map((id) => `presence:${id}`);
    const results = await redis.mget(...keys);
    return Object.fromEntries(
      userIds.map((id, i) => [id, results[i] !== null])
    );
  } catch {
    return {};
  }
}
