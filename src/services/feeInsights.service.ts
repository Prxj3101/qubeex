import type { AcademicClient } from "../utils/academicContext";
import { prisma } from "../utils/prisma";
import { getAcademicClient } from "./tenantDb.service";
import { getCache, setCache } from "../utils/cache";
import { recordAiUsage, getInstitutionAiTokenLimit, getInstitutionPoolUsed } from "./ai-usage.service";
import { computeDefaultAcademicYearWindow } from "../utils/academicYear";

// ── Raw fee-collection stats (shared by the admin's own view and the
// cross-institution peer-benchmark pool) ───────────────────────────────────

interface FeeMonth {
  id: string;
  month: string;
  dueDate: string; // free-text like "10 Aug 26" — must be parsed, never compared as a string
}

export interface FeeHistoricalPoint {
  month: string; // e.g. "August"
  rate: number; // 0-100, % of dues paid that month
}

export interface FeeStatsResult {
  studentCount: number;
  monthlyPaid: number;
  monthlyTotal: number;
  overallPaid: number;
  overallTotal: number;
  // Up to the last 6 calendar months that have already gone past their due
  // date, oldest first — the actual trend line the forecast extrapolates from.
  historical: FeeHistoricalPoint[];
}

function dueDateMs(dueDate: string): number {
  const t = new Date(dueDate).getTime();
  return Number.isNaN(t) ? Infinity : t;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Resolves the institution's current academic year using the *given* client
// rather than the ambient request-scoped one (utils/academicYear.ts's
// getCurrentAcademicYear relies on academicDb(), which is bound to whichever
// institution's client is active in the current async scope). This function
// is also called from getPeerAggregate's cross-institution loop below, which
// deliberately uses each peer institution's own client (possibly a separate
// BYOD database) rather than the calling admin's — using the ambient client
// there would silently query the wrong institution's database.
async function resolveCurrentAcademicYearForClient(client: AcademicClient, institutionId: string) {
  const existing = await client.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
  if (existing) return existing;
  const { label, startDate, endDate } = computeDefaultAcademicYearWindow();
  try {
    return await client.academicYear.create({
      data: { institutionId, label, startDate, endDate, isCurrent: true, status: "ACTIVE" },
    });
  } catch (err) {
    const retry = await client.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
    if (retry) return retry;
    throw err;
  }
}

// Same headcount-based "collection rate" convention as the existing
// /admin/insights/fees endpoint (paid students / total students, not rupee
// amounts) — kept consistent so the AI card's numbers never disagree with
// the donut/accordion above it.
export async function computeInstitutionFeeStats(client: AcademicClient, institutionId: string): Promise<FeeStatsResult> {
  const currentYear = await resolveCurrentAcademicYearForClient(client, institutionId);
  const standards = await client.standard.findMany({
    where: { institutionId },
    select: {
      divisions: {
        select: {
          id: true,
          _count: { select: { students: { where: { status: "ACTIVE" } } } },
          feeStructures: { select: { feeMonths: true }, where: { academicYearId: currentYear.id } },
        },
      },
    },
  });

  const todayMs = Date.now();
  const currentCalendarMonth = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Kolkata", month: "long" });
  const divisions = standards.flatMap((s) => s.divisions);

  let studentCount = 0;
  let monthlyTotal = 0;
  let overallTotal = 0;
  const monthIdsToFetch = new Set<string>();
  const perDivision: {
    divisionId: string;
    total: number;
    pastMonthIds: string[];
    currentMonthId: string | null;
    pastMonths: FeeMonth[];
  }[] = [];

  for (const d of divisions) {
    const total = d._count.students;
    studentCount += total;
    const months = (d.feeStructures[0]?.feeMonths as FeeMonth[] | null) ?? [];
    if (months.length === 0) continue;

    const sorted = [...months].sort((a, b) => dueDateMs(a.dueDate) - dueDateMs(b.dueDate));
    const past = sorted.filter((m) => dueDateMs(m.dueDate) <= todayMs);
    const currentMonth = months.find((m) => m.month === currentCalendarMonth)
      ?? (past.length > 0 ? past[past.length - 1] : sorted[0]) ?? null;

    if (currentMonth) {
      monthIdsToFetch.add(currentMonth.id);
      monthlyTotal += total;
    }
    past.forEach((m) => monthIdsToFetch.add(m.id));
    overallTotal += total * past.length;
    perDivision.push({ divisionId: d.id, total, pastMonthIds: past.map((m) => m.id), currentMonthId: currentMonth?.id ?? null, pastMonths: past });
  }

  const payments = monthIdsToFetch.size
    ? await client.studentFeePayment.findMany({
        where: { institutionId, feeMonthId: { in: Array.from(monthIdsToFetch) }, status: "PAID" },
        select: { studentId: true, feeMonthId: true, student: { select: { divisionId: true } } },
      })
    : [];

  const paidSetByDivisionMonth = new Map<string, Set<string>>();
  for (const p of payments) {
    const divisionId = p.student.divisionId;
    if (!divisionId) continue;
    const key = `${divisionId}:${p.feeMonthId}`;
    const set = paidSetByDivisionMonth.get(key) ?? new Set<string>();
    set.add(p.studentId);
    paidSetByDivisionMonth.set(key, set);
  }

  let monthlyPaid = 0;
  let overallPaid = 0;
  const monthTotals = new Map<string, { paid: number; total: number; dueMs: number }>();

  for (const d of perDivision) {
    if (d.currentMonthId) {
      monthlyPaid += paidSetByDivisionMonth.get(`${d.divisionId}:${d.currentMonthId}`)?.size ?? 0;
    }
    for (const m of d.pastMonths) {
      const paidCount = paidSetByDivisionMonth.get(`${d.divisionId}:${m.id}`)?.size ?? 0;
      overallPaid += paidCount;

      const entry = monthTotals.get(m.month) ?? { paid: 0, total: 0, dueMs: dueDateMs(m.dueDate) };
      entry.paid += paidCount;
      entry.total += d.total;
      entry.dueMs = Math.min(entry.dueMs, dueDateMs(m.dueDate));
      monthTotals.set(m.month, entry);
    }
  }

  const historical: FeeHistoricalPoint[] = Array.from(monthTotals.entries())
    .map(([month, { paid, total, dueMs }]) => ({ month, rate: total > 0 ? (paid / total) * 100 : 0, dueMs }))
    .sort((a, b) => a.dueMs - b.dueMs)
    .slice(-6)
    .map(({ month, rate }) => ({ month, rate }));

  return { studentCount, monthlyPaid, monthlyTotal, overallPaid, overallTotal, historical };
}

// ── AI Fee Health Score ─────────────────────────────────────────────────────
// A single 0-100 number blending this month's collection rate (the most
// actionable signal), the overall/past-dues rate (the accumulated picture),
// and whether the trend is improving or worsening month over month — so a
// school that's "recovering" scores differently from one that looks the same
// today but is sliding.
export function computeFeeHealthScore(stats: FeeStatsResult): { score: number; label: string } {
  const monthlyRate = stats.monthlyTotal > 0 ? (stats.monthlyPaid / stats.monthlyTotal) * 100 : 100;
  const overallRate = stats.overallTotal > 0 ? (stats.overallPaid / stats.overallTotal) * 100 : 100;

  let trendComponent = 50; // neutral when there isn't enough history yet
  if (stats.historical.length >= 2) {
    const delta = stats.historical[stats.historical.length - 1].rate - stats.historical[stats.historical.length - 2].rate;
    trendComponent = Math.max(0, Math.min(100, 50 + delta * 2));
  }

  const score = Math.round(Math.max(0, Math.min(100, monthlyRate * 0.5 + overallRate * 0.3 + trendComponent * 0.2)));
  const label = score >= 80 ? "Excellent" : score >= 60 ? "Good" : score >= 40 ? "Needs Attention" : "Critical";
  return { score, label };
}

// ── AI Collection Forecast ───────────────────────────────────────────────────
// Extrapolates one point past the actual trend line using the average
// month-over-month delta of the recent history — deliberately simple (no
// external model) so it's fast, explainable, and never disagrees wildly with
// what the admin can already see in the trend by eye.
export interface ForecastPoint extends FeeHistoricalPoint {
  projected?: boolean;
}

export function computeFeeForecast(historical: FeeHistoricalPoint[]): ForecastPoint[] {
  if (historical.length === 0) return [];
  const points: ForecastPoint[] = historical.map((h) => ({ ...h }));
  if (historical.length >= 2) {
    const deltas: number[] = [];
    for (let i = 1; i < historical.length; i++) deltas.push(historical[i].rate - historical[i - 1].rate);
    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const last = historical[historical.length - 1];
    const lastIdx = MONTH_NAMES.indexOf(last.month);
    const nextMonth = lastIdx >= 0 ? MONTH_NAMES[(lastIdx + 1) % 12] : "Next Month";
    const projectedRate = Math.max(0, Math.min(100, last.rate + avgDelta));
    points.push({ month: nextMonth, rate: Math.round(projectedRate * 10) / 10, projected: true });
  }
  return points;
}

// ── AI-generated forecast ───────────────────────────────────────────────────
// The plain extrapolation above (computeFeeForecast) is a fixed formula —
// admins correctly pointed out it isn't really "AI", it's just an average
// delta projected forward. This asks an actual LLM to read the same
// month-by-month history and reason about the next month's likely range,
// the same way the Blackboard AI features call out to OpenAI/Groq
// (see blackboard.controller.ts for the identical client-bootstrap pattern).
// If no API key is configured, the monthly token pool is exhausted, or the
// call fails for any reason, this falls back to computeFeeForecast so the
// card never breaks — callers should treat `null` as "use the fallback".
const OpenAIModule = (process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY) ? require("openai") : null;
const openai: import("openai").OpenAI | null = OpenAIModule
  ? new OpenAIModule.OpenAI(
      process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : { apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" }
    )
  : null;
const FEE_AI_MODEL = process.env.OPENAI_API_KEY ? "gpt-4.1-mini" : "openai/gpt-oss-120b";
const FEE_AI_PROVIDER: "openai" | "groq" = process.env.OPENAI_API_KEY ? "openai" : "groq";

export interface AiForecastResult {
  month: string;
  low: number;
  high: number;
  insight: string; // one short, plain-language sentence explaining the reasoning
}

// The outer getFeeAiInsights response cache is only 5 minutes, and gets
// invalidated instantly whenever an admin edits a fee payment (so the health
// score / peer benchmark / historical bars stay fresh) — but that meant an
// admin marking fees paid one student at a time re-triggered a real LLM call
// on every single edit, quietly burning through the token pool. The actual
// model call is throttled separately here to once per institution per rolling
// 12-hour window, completely decoupled from that 5-minute cache: a
// fee-payment edit still busts the outer cache and refreshes the non-AI
// numbers immediately, but this function just hands back the current
// window's already-generated forecast instead of calling the model again.
const FEE_FORECAST_THROTTLE_MS = 12 * 60 * 60 * 1000;
const FEE_FORECAST_THROTTLE_TTL_SECONDS = 13 * 60 * 60; // slightly over the window so a slow request right at the boundary doesn't miss by a hair
function feeForecastThrottleCacheKey(institutionId: string): string {
  const bucket = Math.floor(Date.now() / FEE_FORECAST_THROTTLE_MS);
  return `insights:fee-ai-forecast:v1:${institutionId}:${bucket}`;
}

export async function generateAiFeeForecast(
  historical: FeeHistoricalPoint[],
  ctx: { institutionId: string; userId: string; userRole: string }
): Promise<AiForecastResult | null> {
  if (!openai || historical.length < 2) return null;

  const throttleCacheKey = feeForecastThrottleCacheKey(ctx.institutionId);
  const cached = await getCache<AiForecastResult>(throttleCacheKey);
  if (cached) return cached;

  // Same hard-stop the Blackboard AI features use — never let this quietly
  // blow past the institution's monthly token allowance.
  const [used, limit] = await Promise.all([
    getInstitutionPoolUsed(ctx.institutionId).catch(() => 0),
    getInstitutionAiTokenLimit(ctx.institutionId).catch(() => 0),
  ]);
  if (limit > 0 && used >= limit) return null;

  const lastIdx = MONTH_NAMES.indexOf(historical[historical.length - 1].month);
  const nextMonth = lastIdx >= 0 ? MONTH_NAMES[(lastIdx + 1) % 12] : "next month";

  const systemPrompt =
    "You are a school-fee collection analyst. You are given a school's month-by-month fee collection rate history (percentage of expected students who paid that month). " +
    "Predict the collection rate range for the next month, and give exactly one short, plain-language sentence explaining your reasoning (mention the trend direction, not jargon — a school admin with no data background must understand it instantly). " +
    `Return ONLY a JSON object: { "low": <number 0-100>, "high": <number 0-100>, "insight": "<one sentence, max 25 words>" }. "low" must be <= "high", and the gap should reflect how volatile the recent history looks (tighter for a stable trend, wider for an erratic one).`;
  const userPrompt = `Month-by-month collection rate history (oldest to newest): ${historical
    .map((h) => `${h.month}: ${h.rate.toFixed(1)}%`)
    .join(", ")}. Predict ${nextMonth}.`;

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: FEE_AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 200,
      ...(FEE_AI_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
    });
  } catch (err) {
    await recordAiUsage({
      institutionId: ctx.institutionId,
      userId: ctx.userId,
      userRole: ctx.userRole,
      feature: "FEE_FORECAST",
      provider: FEE_AI_PROVIDER,
      model: FEE_AI_MODEL,
      requestType: "chat_completion",
      status: "FAILED",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  await recordAiUsage({
    institutionId: ctx.institutionId,
    userId: ctx.userId,
    userRole: ctx.userRole,
    feature: "FEE_FORECAST",
    provider: FEE_AI_PROVIDER,
    model: FEE_AI_MODEL,
    requestType: "chat_completion",
    status: "SUCCESS",
    inputTokens: completion.usage?.prompt_tokens,
    outputTokens: completion.usage?.completion_tokens,
    totalTokens: completion.usage?.total_tokens,
  });

  try {
    const parsed = JSON.parse(completion.choices[0].message.content ?? "{}");
    const low = Number(parsed.low);
    const high = Number(parsed.high);
    const insight = typeof parsed.insight === "string" ? parsed.insight.trim() : "";
    if (!Number.isFinite(low) || !Number.isFinite(high) || !insight) return null;
    const result: AiForecastResult = {
      month: nextMonth,
      low: Math.max(0, Math.min(100, Math.min(low, high))),
      high: Math.max(0, Math.min(100, Math.max(low, high))),
      insight: insight.slice(0, 200),
    };
    await setCache(throttleCacheKey, result, FEE_FORECAST_THROTTLE_TTL_SECONDS);
    return result;
  } catch {
    return null;
  }
}

// ── Peer Benchmark ───────────────────────────────────────────────────────────
// Compares this institution's current-month collection rate against other
// institutions on the platform in the same size bracket. The per-institution
// pass is expensive (loops every institution, including BYOD tenants on their
// own database) so the raw aggregate is cached platform-wide for a day; each
// admin's request just looks up their own percentile within that cached list,
// which is cheap. No institution's name or specific numbers are ever exposed
// to another institution — only the caller's own percentile and peer count.
interface PeerAggregateEntry {
  institutionId: string;
  studentCount: number;
  monthlyRate: number;
}

const PEER_AGGREGATE_CACHE_KEY = "insights:fee-peer-benchmark:v1";
const PEER_AGGREGATE_TTL_SECONDS = 24 * 60 * 60;

async function getPeerAggregate(): Promise<PeerAggregateEntry[]> {
  const cached = await getCache<PeerAggregateEntry[]>(PEER_AGGREGATE_CACHE_KEY);
  if (cached) return cached;

  const institutions = await prisma.institution.findMany({ select: { id: true } });
  const settled = await Promise.allSettled(
    institutions.map(async (inst): Promise<PeerAggregateEntry | null> => {
      const client = await getAcademicClient(inst.id);
      const stats = await computeInstitutionFeeStats(client, inst.id);
      if (stats.monthlyTotal === 0) return null;
      return { institutionId: inst.id, studentCount: stats.studentCount, monthlyRate: (stats.monthlyPaid / stats.monthlyTotal) * 100 };
    })
  );

  const results = settled
    .filter((r): r is PromiseFulfilledResult<PeerAggregateEntry | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v): v is PeerAggregateEntry => v !== null);

  await setCache(PEER_AGGREGATE_CACHE_KEY, results, PEER_AGGREGATE_TTL_SECONDS);
  return results;
}

function sizeBucket(studentCount: number): "small" | "medium" | "large" {
  if (studentCount < 300) return "small";
  if (studentCount < 800) return "medium";
  return "large";
}

export interface PeerBenchmarkResult {
  percentile: number; // this institution scores better than X% of peers in its bucket
  peerCount: number;
  bucketLabel: "small" | "medium" | "large";
}

export async function getFeePeerBenchmark(institutionId: string, myStats: FeeStatsResult): Promise<PeerBenchmarkResult | null> {
  if (myStats.monthlyTotal === 0) return null;
  const all = await getPeerAggregate();
  const myBucket = sizeBucket(myStats.studentCount);
  // Excludes this institution itself from its own peer pool.
  const peers = all.filter((e) => e.institutionId !== institutionId && sizeBucket(e.studentCount) === myBucket);
  // Too small a pool would make the percentile meaningless (or worse, let an
  // admin infer a specific other school's number) — hide the card instead.
  if (peers.length < 3) return null;

  const myRate = (myStats.monthlyPaid / myStats.monthlyTotal) * 100;
  const better = peers.filter((p) => p.monthlyRate <= myRate).length;
  const percentile = Math.round((better / peers.length) * 100);
  return { percentile, peerCount: peers.length, bucketLabel: myBucket };
}
