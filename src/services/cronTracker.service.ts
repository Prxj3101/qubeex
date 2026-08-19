import { redis, isRedisReady } from "../utils/redis";

interface CronRunRecord {
  lastRunAt: string;
  ok: boolean;
  error?: string;
}

const CRON_KEY_PREFIX = "health:cron:";
const CRON_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — long enough to always show the last run

/** Call at the end of a cron job's run to record whether it succeeded. */
export async function recordCronRun(name: string, ok: boolean, error?: string): Promise<void> {
  if (!redis || !isRedisReady) return;
  const record: CronRunRecord = { lastRunAt: new Date().toISOString(), ok, ...(error ? { error } : {}) };
  try {
    await redis.setex(`${CRON_KEY_PREFIX}${name}`, CRON_TTL_SECONDS, JSON.stringify(record));
  } catch {
    // Best-effort — never let tracking failure affect the cron itself.
  }
}

export interface CronStatus extends CronRunRecord {
  name: string;
}

/** Reads the last recorded run for every named cron job. */
export async function getCronStatuses(names: string[]): Promise<CronStatus[]> {
  if (!redis || !isRedisReady) return names.map((name) => ({ name, lastRunAt: "", ok: false }));
  try {
    const values = await redis.mget(...names.map((n) => `${CRON_KEY_PREFIX}${n}`));
    return names.map((name, i) => {
      const raw = values[i];
      if (!raw) return { name, lastRunAt: "", ok: false };
      const parsed = JSON.parse(raw) as CronRunRecord;
      return { name, ...parsed };
    });
  } catch {
    return names.map((name) => ({ name, lastRunAt: "", ok: false }));
  }
}
