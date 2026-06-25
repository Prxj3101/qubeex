import { redis, isRedisReady } from "./redis";

export async function getCache<T>(key: string): Promise<T | null> {
  if (!redis || !isRedisReady) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function setCache(key: string, data: unknown, ttlSeconds: number): Promise<void> {
  if (!redis || !isRedisReady) return;
  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(data));
  } catch {
  }
}

export async function delCache(...keys: string[]): Promise<void> {
  if (!redis || !isRedisReady || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch {
  }
}
