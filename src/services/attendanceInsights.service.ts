import { getCache, setCache } from "../utils/cache";
import { recordAiUsage, getInstitutionAiTokenLimit, getInstitutionPoolUsed } from "./ai-usage.service";

// ── AI-generated attendance summary ─────────────────────────────────────────
// A real LLM call (same OpenAI/Groq client-bootstrap pattern as
// feeInsights.service.ts's generateAiFeeForecast and the Blackboard AI
// features) that reads the institution's current attendance snapshot — its
// overall/this-month rates, which divisions are lagging, how many students
// have an active absence streak, and whether any weekday stands out — and
// writes one short, plain-language sentence an admin can act on. If the
// model is unavailable, the token pool is exhausted, or the call fails for
// any reason, this returns null — callers should just omit the summary
// rather than block the rest of the card on it.
const OpenAIModule = (process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY) ? require("openai") : null;
const openai: import("openai").OpenAI | null = OpenAIModule
  ? new OpenAIModule.OpenAI(
      process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : { apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" }
    )
  : null;
const ATTENDANCE_AI_MODEL = process.env.OPENAI_API_KEY ? "gpt-4.1-mini" : "openai/gpt-oss-120b";
const ATTENDANCE_AI_PROVIDER: "openai" | "groq" = process.env.OPENAI_API_KEY ? "openai" : "groq";

export interface AttendanceSummaryInput {
  overallRate: number; // 0-100, institution-wide average of each division's session-to-date %
  monthlyRate: number; // 0-100, institution-wide average of each division's this-month %
  worstDivisions: { name: string; pct: number }[]; // up to 3, lowest this-month %, sorted ascending
  streakAlertCount: number; // number of students currently on a 3+ day absence streak
  dayPatternInsight: string | null; // e.g. "Attendance drops 14% on Saturdays compared to the weekly average."
}

// Same 12-hour throttle as the fee forecast: the outer insights cache is only
// 5 minutes (and gets busted on every attendance save, see
// teacher.routes.ts's daily-attendance POST), which would otherwise
// re-trigger a real LLM call on every single mark — this decouples the
// actual model call to once per institution per rolling 12-hour window.
const ATTENDANCE_AI_THROTTLE_MS = 12 * 60 * 60 * 1000;
const ATTENDANCE_AI_THROTTLE_TTL_SECONDS = 13 * 60 * 60;
function attendanceAiThrottleCacheKey(institutionId: string): string {
  const bucket = Math.floor(Date.now() / ATTENDANCE_AI_THROTTLE_MS);
  return `insights:attendance-ai-summary:v1:${institutionId}:${bucket}`;
}

export async function generateAiAttendanceSummary(
  input: AttendanceSummaryInput,
  ctx: { institutionId: string; userId: string; userRole: string }
): Promise<string | null> {
  if (!openai) return null;

  const throttleCacheKey = attendanceAiThrottleCacheKey(ctx.institutionId);
  const cached = await getCache<string>(throttleCacheKey);
  if (cached) return cached;

  const [used, limit] = await Promise.all([
    getInstitutionPoolUsed(ctx.institutionId).catch(() => 0),
    getInstitutionAiTokenLimit(ctx.institutionId).catch(() => 0),
  ]);
  if (limit > 0 && used >= limit) return null;

  const systemPrompt =
    "You are a school-attendance analyst. You are given a snapshot of a school's attendance data: the overall and this-month attendance rates, the worst-performing classes, how many students are on an active multi-day absence streak, and any weekday pattern already detected. " +
    "Write exactly one short, plain-language sentence (max 25 words) that a busy school admin can read in one glance and know what needs attention. Prioritize the most actionable fact — a streak count or a lagging class matters more than a small rate change. Do not repeat every number given; pick what matters most. " +
    'Return ONLY a JSON object: { "summary": "<one sentence, max 25 words>" }.';
  const userPrompt = JSON.stringify({
    overallRate: input.overallRate,
    monthlyRate: input.monthlyRate,
    worstDivisions: input.worstDivisions,
    studentsOnAbsenceStreak: input.streakAlertCount,
    weekdayPattern: input.dayPatternInsight,
  });

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: ATTENDANCE_AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 120,
      ...(ATTENDANCE_AI_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
    });
  } catch (err) {
    await recordAiUsage({
      institutionId: ctx.institutionId,
      userId: ctx.userId,
      userRole: ctx.userRole,
      feature: "ATTENDANCE_SUMMARY",
      provider: ATTENDANCE_AI_PROVIDER,
      model: ATTENDANCE_AI_MODEL,
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
    feature: "ATTENDANCE_SUMMARY",
    provider: ATTENDANCE_AI_PROVIDER,
    model: ATTENDANCE_AI_MODEL,
    requestType: "chat_completion",
    status: "SUCCESS",
    inputTokens: completion.usage?.prompt_tokens,
    outputTokens: completion.usage?.completion_tokens,
    totalTokens: completion.usage?.total_tokens,
  });

  try {
    const parsed = JSON.parse(completion.choices[0].message.content ?? "{}");
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) return null;
    const result = summary.slice(0, 200);
    await setCache(throttleCacheKey, result, ATTENDANCE_AI_THROTTLE_TTL_SECONDS);
    return result;
  } catch {
    return null;
  }
}
