import { prisma } from "../utils/prisma";
import { redis, isRedisReady } from "../utils/redis";

export type AiFeature =
  | "BLACKBOARD_CONTEXT"
  | "BLACKBOARD_SCAN"
  | "BLACKBOARD_CHAT"
  | "BLACKBOARD_QUIZ"
  | "BLACKBOARD_MINDMAP"
  | "TASK_QUESTION_GENERATION"
  | "FEE_FORECAST";

// The institution/teacher token pool is a *monthly* allowance (see
// PLAN_AI_TOKENS in billing.service), but the Redis counters that back the
// hard-stop check and the "X / limit tokens" UI used to be a single
// never-reset accumulator — so usage from every month ever kept piling up
// instead of the pool actually refilling on the 1st. Keying the counter by
// the current IST calendar month fixes that with no cron needed: once the
// month rolls over, reads/writes automatically land on a fresh key that
// starts at 0 (a missing Redis key just reads back as 0/null). Every read
// and write of these counters anywhere in the codebase must go through
// these two helpers — a hardcoded `ai:usage:institution:${id}` (no month
// suffix) is the old, never-reset behavior creeping back in.
const USAGE_KEY_TTL_SECONDS = 45 * 24 * 60 * 60; // ~1.5 months — old months' keys self-clean instead of accumulating in Redis forever
export function institutionUsageRedisKey(institutionId: string, at: Date = new Date()): string {
  return `ai:usage:institution:${institutionId}:${istMonthKey(at)}`;
}
export function teacherUsageRedisKey(teacherId: string, at: Date = new Date()): string {
  return `ai:usage:teacher:${teacherId}:${istMonthKey(at)}`;
}

export interface RecordAiUsageParams {
  institutionId: string;
  teacherId?: string;
  userId: string;
  userRole: string;
  feature: AiFeature;
  provider: "openai" | "groq";
  model: string;
  requestType: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  status: "SUCCESS" | "FAILED";
  error?: string;
}

// Central tracking entry point — every real AI call in the platform routes
// through this. Writes the event row (source of truth for all reporting)
// and, on success, increments the same Redis counters the pre-existing
// institution hard-stop (checkTokenPool) already reads — that check is left
// completely unmodified, this function just becomes the one place both the
// event log and the counters get written instead of each call site doing
// its own `deductTokens`.
export async function recordAiUsage(params: RecordAiUsageParams): Promise<void> {
  try {
    await prisma.aiUsageEvent.create({
      data: {
        institutionId: params.institutionId,
        teacherId: params.teacherId,
        userId: params.userId,
        userRole: params.userRole,
        feature: params.feature,
        provider: params.provider,
        model: params.model,
        requestType: params.requestType,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        totalTokens: params.totalTokens,
        status: params.status,
        error: params.error?.slice(0, 500),
      },
    });
  } catch (err) {
    // A logging failure must never break the AI feature itself.
    console.error("[ai-usage] Failed to record AiUsageEvent:", err);
  }

  if (params.status !== "SUCCESS") return;
  const tokens = params.totalTokens ?? 0;
  if (!redis || !isRedisReady || tokens <= 0) return;
  const institutionKey = institutionUsageRedisKey(params.institutionId);
  await redis.incrby(institutionKey, tokens).catch(() => {});
  await redis.expire(institutionKey, USAGE_KEY_TTL_SECONDS).catch(() => {});
  if (params.teacherId) {
    const teacherKey = teacherUsageRedisKey(params.teacherId);
    await redis.incrby(teacherKey, tokens).catch(() => {});
    await redis.expire(teacherKey, USAGE_KEY_TTL_SECONDS).catch(() => {});
  }
}

import { getAiTokenLimit } from "./billing.service";

// Single source of truth for the institution's monthly token ceiling lives in
// billing.service (it also folds in the active extraAiTokens addon, which an
// earlier local reimplementation here silently dropped). This alias exists only
// so existing importers of `getInstitutionAiTokenLimit` keep working — do not
// reimplement plan lookup here.
export const getInstitutionAiTokenLimit = getAiTokenLimit;

export interface FeatureBreakdownEntry {
  feature: AiFeature;
  requests: number;
  successRequests: number;
  failedRequests: number;
  totalTokens: number;
}

// All AI-usage date maths is done on the IST calendar (the product's operating
// timezone — same convention as the fee/attendance insights, which use
// "Asia/Kolkata" explicitly). Range boundaries and trend bucket keys must share
// one basis, otherwise a request made in the evening IST lands in the previous
// UTC day and the chart's first/last bucket silently disagrees with the range.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Y/M/D of the given instant as seen on the IST wall clock.
function istParts(d: Date): { y: number; m: number; d: number } {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

// The UTC instant of IST-midnight for the given IST calendar date.
// Date.UTC normalises out-of-range month/day values (e.g. m = -1), so callers
// can freely pass "this month minus 3" without handling year rollover.
function istMidnightUtc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);
}

// "YYYY-MM-DD" on the IST calendar — the canonical day-bucket key.
export function istDayKey(d: Date): string {
  const p = istParts(d);
  return `${p.y}-${String(p.m + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

// "YYYY-MM" on the IST calendar — the canonical month-bucket key.
export function istMonthKey(d: Date): string {
  return istDayKey(d).slice(0, 7);
}

// UTC instant of the 1st of the current IST calendar month, 00:00 IST — the
// "since the pool last reset" boundary. Any usage view that's meant to
// track the same monthly pool as the Redis counter (institutionUsageRedisKey)
// must use this as its `from`, not an arbitrary rolling window or all-time.
export function currentMonthStartIST(): Date {
  const { y, m } = istParts(new Date());
  return istMidnightUtc(y, m, 1);
}

// The Redis "used" counter (institutionUsageRedisKey) is meant to track the
// current month's pool 1:1 with the AiUsageEvent log, but recordAiUsage's
// redis.incrby is best-effort: if Redis drops mid-connection (ioredis here
// stops retrying after 3 attempts and won't reconnect on error — see
// utils/redis.ts) every increment that happens while isRedisReady is false
// is written to Postgres but silently never reaches Redis. The counter then
// sits permanently stuck below the real total, even after Redis reconnects,
// until the process restarts and clears the stale in-memory value.
// Reconciling against the Postgres month-total on every read (and writing
// the corrected number back to Redis) makes the displayed pool figure
// self-healing instead of permanently drifting.
export async function getInstitutionPoolUsed(institutionId: string): Promise<number> {
  const from = currentMonthStartIST();
  const [redisRaw, postgresTotal] = await Promise.all([
    redis && isRedisReady ? redis.get(institutionUsageRedisKey(institutionId)).catch(() => null) : Promise.resolve(null),
    prisma.aiUsageEvent.aggregate({
      where: { institutionId, status: "SUCCESS", createdAt: { gte: from } },
      _sum: { totalTokens: true },
    }).then((r) => r._sum.totalTokens ?? 0),
  ]);

  const redisValue = Number(redisRaw ?? 0) || 0;
  const trueValue = Math.max(redisValue, postgresTotal);

  if (redis && isRedisReady && trueValue > redisValue) {
    const key = institutionUsageRedisKey(institutionId);
    redis.set(key, trueValue).catch(() => {});
    redis.expire(key, USAGE_KEY_TTL_SECONDS).catch(() => {});
  }

  return trueValue;
}

export function rangeToFromDate(range: "7D" | "1M" | "3M" | "6M" | "YTD"): Date {
  const { y, m, d } = istParts(new Date());
  switch (range) {
    case "7D": return istMidnightUtc(y, m, d - 7);
    case "1M": return istMidnightUtc(y, m - 1, d);
    case "3M": return istMidnightUtc(y, m - 3, d);
    case "6M": return istMidnightUtc(y, m - 6, d);
    case "YTD": return istMidnightUtc(y, 0, 1);
    default: return istMidnightUtc(y, m - 1, d);
  }
}

export function bucketGranularity(range: string): "day" | "month" {
  return range === "7D" || range === "1M" ? "day" : "month";
}

export interface TrendPoint { period: string; requests: number; totalTokens: number; }

function nextBucketKey(key: string, granularity: "day" | "month"): string {
  if (granularity === "month") {
    const [y, m] = key.split("-").map(Number);
    const next = new Date(Date.UTC(y, m, 1)); // m is 1-based here, so this is the next month
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const [y, m, d] = key.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

// Safety valve: a caller passing an unbounded `from` (e.g. new Date(0)) must not
// make this emit tens of thousands of empty buckets. Past this many, we only
// zero-fill the span that actually contains events.
const MAX_ZERO_FILL_BUCKETS = 800;

// Buckets events into a gap-free, ascending trend series. Zero-usage periods are
// emitted as { requests: 0, totalTokens: 0 } rather than omitted — a line chart
// must draw a flat zero segment for an idle day, not interpolate across it.
// `from`/`to` (optional) extend the zero-fill to the full requested window; with
// them omitted the series still has no interior gaps, it just starts/ends at the
// first/last period that saw an event.
export function bucketEvents(
  events: { createdAt: Date; totalTokens: number | null }[],
  granularity: "day" | "month",
  from?: Date,
  to?: Date
): TrendPoint[] {
  const keyOf = granularity === "day" ? istDayKey : istMonthKey;
  const buckets = new Map<string, { requests: number; totalTokens: number }>();
  for (const e of events) {
    const key = keyOf(e.createdAt);
    const cur = buckets.get(key) ?? { requests: 0, totalTokens: 0 };
    cur.requests += 1;
    cur.totalTokens += e.totalTokens ?? 0;
    buckets.set(key, cur);
  }

  const observed = Array.from(buckets.keys()).sort((a, b) => a.localeCompare(b));
  let start = from ? keyOf(from) : observed[0];
  let end = to ? keyOf(to) : observed[observed.length - 1];
  if (observed.length > 0) {
    if (!start || observed[0].localeCompare(start) < 0) start = observed[0];
    if (!end || observed[observed.length - 1].localeCompare(end) > 0) end = observed[observed.length - 1];
  }
  if (!start || !end || start.localeCompare(end) > 0) {
    return observed.map((period) => ({ period, ...buckets.get(period)! }));
  }

  // Window too wide to zero-fill (e.g. an all-time `from`)? Narrow to the span
  // that actually contains events; if even that is too wide, emit observed
  // buckets only rather than materialising an enormous series.
  if (bucketSpan(start, end, granularity) > MAX_ZERO_FILL_BUCKETS) {
    if (observed.length === 0) return [];
    start = observed[0];
    end = observed[observed.length - 1];
    if (bucketSpan(start, end, granularity) > MAX_ZERO_FILL_BUCKETS) {
      return observed.map((period) => ({ period, ...buckets.get(period)! }));
    }
  }

  const series: TrendPoint[] = [];
  let cursor = start;
  while (cursor.localeCompare(end) <= 0) {
    series.push({ period: cursor, ...(buckets.get(cursor) ?? { requests: 0, totalTokens: 0 }) });
    cursor = nextBucketKey(cursor, granularity);
  }
  return series;
}

// Number of buckets inclusive between two keys of the same granularity.
function bucketSpan(start: string, end: string, granularity: "day" | "month"): number {
  if (granularity === "month") {
    const [sy, sm] = start.split("-").map(Number);
    const [ey, em] = end.split("-").map(Number);
    return (ey * 12 + em) - (sy * 12 + sm) + 1;
  }
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const ms = Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd);
  return Math.round(ms / 86_400_000) + 1;
}

function summarizeEvents(events: { feature: string; status: string; totalTokens: number | null }[]): {
  totalRequests: number; successRequests: number; failedRequests: number; totalTokens: number; byFeature: FeatureBreakdownEntry[];
} {
  const byFeatureMap = new Map<string, FeatureBreakdownEntry>();
  let totalTokens = 0;
  let successRequests = 0;
  let failedRequests = 0;

  for (const e of events) {
    const entry = byFeatureMap.get(e.feature) ?? {
      feature: e.feature as AiFeature, requests: 0, successRequests: 0, failedRequests: 0, totalTokens: 0,
    };
    entry.requests += 1;
    if (e.status === "SUCCESS") { entry.successRequests += 1; successRequests += 1; }
    else { entry.failedRequests += 1; failedRequests += 1; }
    entry.totalTokens += e.totalTokens ?? 0;
    totalTokens += e.totalTokens ?? 0;
    byFeatureMap.set(e.feature, entry);
  }

  return {
    totalRequests: events.length, successRequests, failedRequests, totalTokens,
    byFeature: Array.from(byFeatureMap.values()),
  };
}

// The implicit per-teacher share of the institution's monthly pool: an even
// split across all teachers, on the same monthly scale as the UI's soft-limit
// slider. Used only as a display default when no explicit override is set.
export function computeSoftLimitDefault(institutionAiTokenLimit: number, teacherCount: number): number {
  if (teacherCount <= 0) return 0;
  return Math.round(institutionAiTokenLimit / teacherCount);
}

export interface TeacherUsageSummary {
  teacherId: string;
  totalRequests: number; successRequests: number; failedRequests: number;
  totalTokens: number;
  byFeature: FeatureBreakdownEntry[];
  isOverSoftLimit: boolean;
  // The limit actually in force (explicit override if set, otherwise the
  // computed even-split default). Drives isOverSoftLimit.
  softLimitTokens: number;
  // The admin's explicit override, verbatim — null when they never set one.
  // Consumers must key "is a limit configured?" UI off this, never off
  // softLimitTokens, which is always non-zero for a populated institution.
  softLimitOverride: number | null;
}

function summaryForTeacherEvents(
  teacherId: string,
  events: { feature: string; status: string; totalTokens: number | null }[],
  softLimitTokens: number,
  softLimitOverride: number | null
): TeacherUsageSummary {
  const base = summarizeEvents(events);
  return {
    teacherId,
    ...base,
    softLimitTokens,
    softLimitOverride,
    isOverSoftLimit: softLimitTokens > 0 && base.totalTokens > softLimitTokens,
  };
}

export async function getTeacherUsageSummary(
  institutionId: string, teacherId: string, from: Date, to: Date
): Promise<TeacherUsageSummary> {
  const [events, teacher, institutionLimit, teacherCount] = await Promise.all([
    prisma.aiUsageEvent.findMany({
      where: { institutionId, teacherId, createdAt: { gte: from, lte: to } },
      select: { feature: true, status: true, totalTokens: true },
    }),
    // Tenant-scoped by institutionId, per the platform-wide multi-tenancy rule —
    // never look a teacher up by id alone, even when the caller pre-validated.
    prisma.teacher.findFirst({ where: { id: teacherId, institutionId }, select: { aiSoftLimitTokens: true } }),
    getInstitutionAiTokenLimit(institutionId),
    prisma.teacher.count({ where: { institutionId } }),
  ]);
  const override = teacher?.aiSoftLimitTokens ?? null;
  const softLimit = override ?? computeSoftLimitDefault(institutionLimit, teacherCount);
  return summaryForTeacherEvents(teacherId, events, softLimit, override);
}

export async function getInstitutionTeacherBreakdown(
  institutionId: string, from: Date, to: Date
): Promise<TeacherUsageSummary[]> {
  const [events, teachers, institutionLimit] = await Promise.all([
    prisma.aiUsageEvent.findMany({
      where: { institutionId, createdAt: { gte: from, lte: to }, teacherId: { not: null } },
      select: { teacherId: true, feature: true, status: true, totalTokens: true },
    }),
    prisma.teacher.findMany({ where: { institutionId }, select: { id: true, aiSoftLimitTokens: true } }),
    getInstitutionAiTokenLimit(institutionId),
  ]);
  const teacherCount = teachers.length;
  const byTeacher = new Map<string, { feature: string; status: string; totalTokens: number | null }[]>();
  for (const e of events) {
    if (!e.teacherId) continue;
    const arr = byTeacher.get(e.teacherId) ?? [];
    arr.push({ feature: e.feature, status: e.status, totalTokens: e.totalTokens });
    byTeacher.set(e.teacherId, arr);
  }

  const summaries: TeacherUsageSummary[] = [];
  for (const [teacherId, teacherEvents] of byTeacher.entries()) {
    const teacher = teachers.find(t => t.id === teacherId);
    const override = teacher?.aiSoftLimitTokens ?? null;
    const softLimit = override ?? computeSoftLimitDefault(institutionLimit, teacherCount);
    summaries.push(summaryForTeacherEvents(teacherId, teacherEvents, softLimit, override));
  }
  return summaries;
}

// Institution-wide feature totals, unlike getInstitutionTeacherBreakdown
// which only looks at events with a teacherId set. Some AI features are
// triggered by an admin, not a teacher (e.g. FEE_FORECAST) — those events
// have no teacherId and would silently vanish from any "usage by feature"
// view built only out of the per-teacher breakdown. This is the one place
// that counts every event in the window regardless of who triggered it.
export async function getInstitutionByFeatureBreakdown(
  institutionId: string, from: Date, to: Date
): Promise<FeatureBreakdownEntry[]> {
  const events = await prisma.aiUsageEvent.findMany({
    where: { institutionId, createdAt: { gte: from, lte: to } },
    select: { feature: true, status: true, totalTokens: true },
  });
  return summarizeEvents(events).byFeature;
}

export interface InstitutionUsageSummary {
  totalRequests: number; successRequests: number; failedRequests: number; totalTokens: number;
  byFeature: FeatureBreakdownEntry[];
  trend: TrendPoint[];
}

export async function getInstitutionUsageSummary(institutionId: string, range: string): Promise<InstitutionUsageSummary> {
  const from = rangeToFromDate(range as "7D" | "1M" | "3M" | "6M" | "YTD");
  const events = await prisma.aiUsageEvent.findMany({
    where: { institutionId, createdAt: { gte: from } },
    select: { feature: true, status: true, totalTokens: true, createdAt: true },
  });
  const base = summarizeEvents(events);
  const trend = bucketEvents(events, bucketGranularity(range), from, new Date());
  return { ...base, trend };
}

export interface MonthlyAiUsagePoint {
  month: string; // "YYYY-MM", IST calendar
  totalTokens: number;
}

// Calendar-month usage for the last `months` months (current month included),
// read straight from the AiUsageEvent log rather than the Redis counter —
// Redis only ever holds the *current* month's running total (see
// institutionUsageRedisKey's TTL-based rollover) and isn't a source of
// history. Used by the superadmin institution page to show "how much of the
// pool did this institution actually use in each of the last few months",
// which the old single never-reset Redis counter couldn't answer at all.
export async function getInstitutionMonthlyAiUsage(institutionId: string, months = 5): Promise<MonthlyAiUsagePoint[]> {
  const { y, m } = istParts(new Date());
  const from = istMidnightUtc(y, m - (months - 1), 1);
  const events = await prisma.aiUsageEvent.findMany({
    where: { institutionId, createdAt: { gte: from }, status: "SUCCESS" },
    select: { createdAt: true, totalTokens: true },
  });

  const byMonth = new Map<string, number>();
  for (const e of events) {
    const key = istMonthKey(e.createdAt);
    byMonth.set(key, (byMonth.get(key) ?? 0) + (e.totalTokens ?? 0));
  }

  const points: MonthlyAiUsagePoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const key = istMonthKey(istMidnightUtc(y, m - i, 1));
    points.push({ month: key, totalTokens: byMonth.get(key) ?? 0 });
  }
  return points;
}

export interface PlatformInstitutionRow { institutionId: string; institutionName: string; requests: number; totalTokens: number; successRate: number; }
export interface PlatformUsageSummary {
  totalRequests: number; successRequests: number; failedRequests: number; totalTokens: number;
  byFeature: FeatureBreakdownEntry[];
  byInstitution: PlatformInstitutionRow[];
  trend: TrendPoint[];
}

export async function getPlatformUsageSummary(range: string): Promise<PlatformUsageSummary> {
  const from = rangeToFromDate(range as "7D" | "1M" | "3M" | "6M" | "YTD");
  const events = await prisma.aiUsageEvent.findMany({
    where: { createdAt: { gte: from } },
    select: { institutionId: true, feature: true, status: true, totalTokens: true, createdAt: true },
  });
  const base = summarizeEvents(events);
  const trend = bucketEvents(events, bucketGranularity(range), from, new Date());

  const byInstitutionMap = new Map<string, { requests: number; totalTokens: number; success: number }>();
  for (const e of events) {
    const cur = byInstitutionMap.get(e.institutionId) ?? { requests: 0, totalTokens: 0, success: 0 };
    cur.requests += 1;
    cur.totalTokens += e.totalTokens ?? 0;
    if (e.status === "SUCCESS") cur.success += 1;
    byInstitutionMap.set(e.institutionId, cur);
  }
  // Every institution on the platform is listed, not just ones with usage in
  // this range — a brand new month (or a quiet institution) should still show
  // up at 0 tokens rather than disappearing from the table entirely.
  const allInstitutions = await prisma.institution.findMany({ select: { id: true, name: true } });
  const byInstitution: PlatformInstitutionRow[] = allInstitutions.map(inst => {
    const v = byInstitutionMap.get(inst.id) ?? { requests: 0, totalTokens: 0, success: 0 };
    return {
      institutionId: inst.id,
      institutionName: inst.name,
      requests: v.requests, totalTokens: v.totalTokens,
      successRate: v.requests > 0 ? Math.round((v.success / v.requests) * 100) : 0,
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens);

  return { ...base, byInstitution, trend };
}
