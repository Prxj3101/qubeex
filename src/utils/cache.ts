import { redis, isRedisReady } from "./redis";

// Redis-backed cache with an in-memory fallback.
//
// Several features rely on this cache not just for speed but as a THROTTLE:
// e.g. the AI fee forecast and AI attendance summary run at most once per
// institution per 12 hours by storing their result here. When Redis was down or
// over its request quota, getCache always returned null and setCache silently
// did nothing - so every Insights page load made a fresh (paid) AI call and
// burned the school's token pool. The memory fallback keeps those throttles
// (and every other cached response) working whenever Redis can't be used.
// It is per server process: a restart starts it empty, which costs at most one
// extra call per key.

const MEMORY_MAX_ENTRIES = 5000;
const memory = new Map<string, { value: string; expiresAt: number }>();

function memGet(key: string): string | null {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return hit.value;
}

function memSet(key: string, value: string, ttlSeconds: number): void {
  if (memory.size >= MEMORY_MAX_ENTRIES) {
    // Drop expired entries first, then the oldest ones (Map keeps insertion order).
    const now = Date.now();
    for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);
    while (memory.size >= MEMORY_MAX_ENTRIES) {
      const oldest = memory.keys().next().value;
      if (oldest === undefined) break;
      memory.delete(oldest);
    }
  }
  memory.delete(key); // re-insert so it counts as newest
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function getCache<T>(key: string): Promise<T | null> {
  if (redis && isRedisReady) {
    try {
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw) as T;
    } catch {
      // Redis error (e.g. quota exceeded) - fall through to memory.
    }
  }
  const local = memGet(key);
  if (!local) return null;
  try {
    return JSON.parse(local) as T;
  } catch {
    return null;
  }
}

export async function setCache(key: string, data: unknown, ttlSeconds: number): Promise<void> {
  const raw = JSON.stringify(data);
  // Always keep a local copy, so a Redis outage or quota limit never turns a
  // throttle into "call the AI on every request".
  memSet(key, raw, ttlSeconds);
  if (!redis || !isRedisReady) return;
  try {
    await redis.setex(key, ttlSeconds, raw);
  } catch {
  }
}

export async function delCache(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  for (const k of keys) memory.delete(k);
  if (!redis || !isRedisReady) return;
  try {
    await redis.del(...keys);
  } catch {
  }
}
