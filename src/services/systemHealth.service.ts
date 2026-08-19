import { prisma } from "../utils/prisma";
import { redis, isRedisReady } from "../utils/redis";
import { getR2Client } from "./storage.service";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";

export type ServiceStatus = "operational" | "degraded" | "down" | "unconfigured";

export interface ServiceCheckResult {
  status: ServiceStatus;
  latencyMs: number | null;
  error?: string;
}

// ── Individual live checks ─────────────────────────────────────────────────────
// Each is a real, timed call against the actual dependency — not a cached flag.

async function timed(fn: () => Promise<void>): Promise<{ latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await fn();
    return { latencyMs: Date.now() - start };
  } catch (err) {
    return { latencyMs: Date.now() - start, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function checkDatabase(): Promise<ServiceCheckResult> {
  const { latencyMs, error } = await timed(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });
  return error ? { status: "down", latencyMs, error } : { status: "operational", latencyMs };
}

export async function checkRedis(): Promise<ServiceCheckResult> {
  const client = redis;
  if (!client) return { status: "unconfigured", latencyMs: null };
  if (!isRedisReady) return { status: "down", latencyMs: null, error: "Not connected" };
  const { latencyMs, error } = await timed(async () => {
    await client.ping();
  });
  return error ? { status: "down", latencyMs, error } : { status: "operational", latencyMs };
}

export async function checkStorage(): Promise<ServiceCheckResult> {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !bucket) {
    return { status: "unconfigured", latencyMs: null };
  }
  const { latencyMs, error } = await timed(async () => {
    const client = getR2Client();
    await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
  });
  return error ? { status: "down", latencyMs, error } : { status: "operational", latencyMs };
}

export async function checkAI(): Promise<ServiceCheckResult> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY;
  if (!apiKey) return { status: "unconfigured", latencyMs: null };
  const { latencyMs, error } = await timed(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OpenAI } = require("openai");
    const client = new OpenAI(
      process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : { apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" }
    );
    await client.models.list(); // no token cost — auth/connectivity check only
  });
  return error ? { status: "down", latencyMs, error } : { status: "operational", latencyMs };
}

export async function checkEmail(): Promise<ServiceCheckResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { status: "unconfigured", latencyMs: null };
  const { latencyMs, error } = await timed(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Resend } = require("resend");
    const client = new Resend(apiKey);
    const res = await client.domains.list();
    if (res.error) throw new Error(res.error.message ?? "Resend API error");
  });
  return error ? { status: "down", latencyMs, error } : { status: "operational", latencyMs };
}

// ── Rolling metrics in Redis ────────────────────────────────────────────────────
// All keys are hour-bucketed and expire after 48h so this never grows unbounded.

const HOUR_MS = 60 * 60 * 1000;
const BUCKET_TTL_SECONDS = 48 * 60 * 60;

function hourBucket(date = new Date()): string {
  return Math.floor(date.getTime() / HOUR_MS).toString();
}

function lastNHourBuckets(n: number): string[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => Math.floor((now - (n - 1 - i) * HOUR_MS) / HOUR_MS).toString());
}

function bucketLabel(bucketKey: string): string {
  const date = new Date(Number(bucketKey) * HOUR_MS);
  return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Records one live-check result for a named service into the current hour's rolling counters. */
export async function recordServiceCheck(service: string, result: ServiceCheckResult): Promise<void> {
  if (!redis || !isRedisReady || result.status === "unconfigured") return;
  const bucket = hourBucket();
  const ok = result.status === "operational" ? 1 : 0;
  try {
    const pipeline = redis.pipeline();
    pipeline.incr(`health:svc:${service}:${bucket}:checks`);
    pipeline.incrby(`health:svc:${service}:${bucket}:ok`, ok);
    if (result.latencyMs !== null) {
      pipeline.incrby(`health:svc:${service}:${bucket}:latSum`, result.latencyMs);
      pipeline.incr(`health:svc:${service}:${bucket}:latCount`);
    }
    for (const suffix of ["checks", "ok", "latSum", "latCount"]) {
      pipeline.expire(`health:svc:${service}:${bucket}:${suffix}`, BUCKET_TTL_SECONDS);
    }
    await pipeline.exec();
  } catch {
    // Best-effort — a metrics write failure must never break the health check itself.
  }
}

/** Uptime % over the last 24h, from recorded check history. Null if no history yet. */
export async function getServiceUptime24h(service: string): Promise<number | null> {
  if (!redis || !isRedisReady) return null;
  const buckets = lastNHourBuckets(24);
  try {
    const keys = buckets.flatMap((b) => [`health:svc:${service}:${b}:checks`, `health:svc:${service}:${b}:ok`]);
    const values = await redis.mget(...keys);
    let totalChecks = 0, totalOk = 0;
    for (let i = 0; i < values.length; i += 2) {
      totalChecks += Number(values[i] ?? 0);
      totalOk += Number(values[i + 1] ?? 0);
    }
    if (totalChecks === 0) return null;
    return Math.round((totalOk / totalChecks) * 10000) / 100;
  } catch {
    return null;
  }
}

/** Average recorded latency (ms) for a service over the last 24h. Null if no samples. */
export async function getServiceAvgLatency24h(service: string): Promise<number | null> {
  if (!redis || !isRedisReady) return null;
  const buckets = lastNHourBuckets(24);
  try {
    const keys = buckets.flatMap((b) => [`health:svc:${service}:${b}:latSum`, `health:svc:${service}:${b}:latCount`]);
    const values = await redis.mget(...keys);
    let sum = 0, count = 0;
    for (let i = 0; i < values.length; i += 2) {
      sum += Number(values[i] ?? 0);
      count += Number(values[i + 1] ?? 0);
    }
    if (count === 0) return null;
    return Math.round(sum / count);
  } catch {
    return null;
  }
}

/** Records one finished HTTP request (called from Express middleware on every request). */
export async function recordApiRequest(durationMs: number, isServerError: boolean): Promise<void> {
  if (!redis || !isRedisReady) return;
  const bucket = hourBucket();
  try {
    const pipeline = redis.pipeline();
    pipeline.incr(`health:api:${bucket}:count`);
    pipeline.incrby(`health:api:${bucket}:sum`, durationMs);
    if (isServerError) pipeline.incr(`health:api:${bucket}:errors`);
    for (const suffix of ["count", "sum", "errors"]) {
      pipeline.expire(`health:api:${bucket}:${suffix}`, BUCKET_TTL_SECONDS);
    }
    await pipeline.exec();
  } catch {
    // Best-effort.
  }
}

export interface HourlyPoint {
  time: string;
  api: number | null;
  db: number | null;
  ai: number | null;
}

/** Response-time series for the last N hours: real API avg (from request middleware) + real DB/AI avg (from the periodic monitor cron). */
export async function getResponseTimeSeries(hours = 12): Promise<HourlyPoint[]> {
  const buckets = lastNHourBuckets(hours);
  if (!redis || !isRedisReady) return buckets.map((b) => ({ time: bucketLabel(b), api: null, db: null, ai: null }));
  try {
    const keys = buckets.flatMap((b) => [
      `health:api:${b}:sum`, `health:api:${b}:count`,
      `health:svc:database:${b}:latSum`, `health:svc:database:${b}:latCount`,
      `health:svc:ai:${b}:latSum`, `health:svc:ai:${b}:latCount`,
    ]);
    const values = await redis.mget(...keys);
    return buckets.map((b, i) => {
      const [apiSum, apiCount, dbSum, dbCount, aiSum, aiCount] = values.slice(i * 6, i * 6 + 6).map(Number);
      return {
        time: bucketLabel(b),
        api: apiCount > 0 ? Math.round(apiSum / apiCount) : null,
        db: dbCount > 0 ? Math.round(dbSum / dbCount) : null,
        ai: aiCount > 0 ? Math.round(aiSum / aiCount) : null,
      };
    });
  } catch {
    return buckets.map((b) => ({ time: bucketLabel(b), api: null, db: null, ai: null }));
  }
}

export interface ErrorRatePoint {
  time: string;
  rate: number | null;
}

/** Error rate (% of requests that were 5xx) for the last N hours. */
export async function getErrorRateSeries(hours = 12): Promise<ErrorRatePoint[]> {
  const buckets = lastNHourBuckets(hours);
  if (!redis || !isRedisReady) return buckets.map((b) => ({ time: bucketLabel(b), rate: null }));
  try {
    const keys = buckets.flatMap((b) => [`health:api:${b}:count`, `health:api:${b}:errors`]);
    const values = await redis.mget(...keys);
    return buckets.map((b, i) => {
      const count = Number(values[i * 2] ?? 0);
      const errors = Number(values[i * 2 + 1] ?? 0);
      return { time: bucketLabel(b), rate: count > 0 ? Math.round((errors / count) * 10000) / 100 : null };
    });
  } catch {
    return buckets.map((b) => ({ time: bucketLabel(b), rate: null }));
  }
}

/** Recent server (5xx) errors, sourced from AuditLog SYSTEM/CRITICAL entries the error handler writes. */
export async function getRecentServerErrors(limit = 20) {
  const logs = await prisma.auditLog.findMany({
    where: { category: "SYSTEM", severity: "CRITICAL" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, action: true, details: true, metadata: true, createdAt: true },
  });
  return logs.map((l) => ({
    id: l.id,
    endpoint: (l.metadata as { endpoint?: string } | null)?.endpoint ?? l.action,
    message: l.details ?? "Unhandled server error",
    time: l.createdAt.toISOString(),
  }));
}
