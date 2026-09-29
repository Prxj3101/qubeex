import crypto from "crypto";
import { recordAiUsage, getInstitutionAiTokenLimit, getInstitutionPoolUsed } from "./ai-usage.service";
import { TooManyRequestsError, BadRequestError } from "../utils/errors";

// ── Smart Review: AI summary ────────────────────────────────────────────────
// The actual checks are rule-based (buildRunReview in payroll.controller) -
// exact and free. The AI only turns those findings into a short, friendly
// summary, so it never does maths and a call costs a few hundred tokens.
// Same OpenAI/Groq bootstrap + token-pool + usage-tracking pattern as
// attendanceInsights.service.ts.
//
// Privacy: staff names in the findings are swapped for codes (S1, S2, ...)
// before sending and swapped back afterwards. No emails, phones, bank or PAN.
const OpenAIModule = (process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY) ? require("openai") : null;
const openai: import("openai").OpenAI | null = OpenAIModule
  ? new OpenAIModule.OpenAI(
      process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : { apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" }
    )
  : null;
const AI_MODEL = process.env.OPENAI_API_KEY ? "gpt-4.1-mini" : "openai/gpt-oss-120b";
const AI_PROVIDER: "openai" | "groq" = process.env.OPENAI_API_KEY ? "openai" : "groq";

export interface AiSummaryInput {
  month: string;
  staffCount: number;
  totalNet: number; // paise
  previous: { month: string; netPay: number } | null;
  findings: { level: "critical" | "warning" | "info"; message: string }[];
  staffNames: string[]; // every name that may appear in the findings (for anonymising)
}

export interface AiReview {
  verdict: "LOOKS_GOOD" | "NEEDS_ATTENTION"; // decided by the rules, not the AI
  summary: string;
}

// Fingerprint of the numbers the review looked at; if it changes, the summary is out of date.
export function reviewHash(payslips: { staffName: string; netPay: number; grossPay: number; lopDays: number; bonus: number; otherDeduction: number }[]): string {
  const key = payslips
    .map((p) => `${p.staffName}|${p.grossPay}|${p.netPay}|${p.lopDays}|${p.bonus}|${p.otherDeduction}`)
    .sort()
    .join(";");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function generatePayrollAiSummary(
  input: AiSummaryInput,
  ctx: { institutionId: string; userId: string; userRole: string },
): Promise<AiReview> {
  const critical = input.findings.filter((f) => f.level === "critical");
  const warnings = input.findings.filter((f) => f.level !== "info");
  const verdict: AiReview["verdict"] = warnings.length ? "NEEDS_ATTENTION" : "LOOKS_GOOD";
  // Nothing to flag: no need to ask the AI at all (zero tokens).
  if (warnings.length === 0) return { verdict, summary: "All clear, ready to pay." };
  if (!openai) throw new BadRequestError("AI is not set up on this server");

  const [used, limit] = await Promise.all([
    getInstitutionPoolUsed(ctx.institutionId).catch(() => 0),
    getInstitutionAiTokenLimit(ctx.institutionId).catch(() => 0),
  ]);
  if (limit > 0 && used >= limit) throw new TooManyRequestsError("Your school's AI tokens for this month are used up");

  // Names -> S1, S2 in the order they appear in what we send (longest name
  // matched first so "Rohit Sharma" wins over "Rohit"). Only people actually in
  // the request get a code, so with one person it's always S1 - the model can't
  // "guess" S1 and land on someone else (that showed Dhoni for Rohit's bonus).
  const names = [...new Set(input.staffNames.filter(Boolean))].sort((a, b) => b.length - a.length);
  const codeOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  const anon = (t: string) => {
    // Assign codes by first position in this text, then replace.
    const found = names
      .map((n) => ({ n, at: t.indexOf(n) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at);
    for (const { n } of found) {
      if (!codeOf.has(n)) {
        const code = `S${codeOf.size + 1}`;
        codeOf.set(n, code);
        nameOf.set(code, n);
      }
    }
    return names.reduce((acc, n) => (codeOf.has(n) ? acc.replace(new RegExp(escapeRe(n), "g"), codeOf.get(n)!) : acc), t);
  };

  // Keep the request small: only red / amber findings (max 4 of each), first
  // sentence only, anonymised. Notes are not sent.
  const short = (m: string) => anon(m.split(/(?<=\.)\s/)[0]).slice(0, 110);
  const fix = critical.slice(0, 4).map((f) => short(f.message));
  const check = input.findings.filter((f) => f.level === "warning").slice(0, 4).map((f) => short(f.message));
  const systemPrompt =
    "Summarise these payroll check findings for a school accountant in ONE short sentence (max 25 words), simple English. " +
    "fix items first. Refer to people ONLY with the exact codes used in the findings (S1, S2); never invent a code. " +
    "Keep each amount with the person it belongs to. No em dash. Reply JSON {\"summary\":\"...\"}";
  const userPrompt = JSON.stringify({ fix, check });

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      // Reasoning models (gpt-oss on Groq) spend part of this on thinking before
      // writing, so it needs headroom even though the summary itself is short.
      max_tokens: 300,
      ...(AI_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
    });
  } catch (err) {
    console.error("[payroll-ai] summary call failed:", err instanceof Error ? err.message : err);
    await recordAiUsage({
      institutionId: ctx.institutionId, userId: ctx.userId, userRole: ctx.userRole,
      feature: "PAYROLL_REVIEW", provider: AI_PROVIDER, model: AI_MODEL, requestType: "chat_completion",
      status: "FAILED", error: err instanceof Error ? err.message : String(err),
    });
    throw new BadRequestError("AI summary is not available right now. Please try again in a bit.");
  }

  await recordAiUsage({
    institutionId: ctx.institutionId, userId: ctx.userId, userRole: ctx.userRole,
    feature: "PAYROLL_REVIEW", provider: AI_PROVIDER, model: AI_MODEL, requestType: "chat_completion",
    status: "SUCCESS",
    inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens, totalTokens: completion.usage?.total_tokens,
  });

  let summary = "";
  try {
    if (!completion.choices[0]?.message?.content) {
      console.error("[payroll-ai] empty reply, finish_reason:", completion.choices[0]?.finish_reason);
    }
    const parsed = JSON.parse(completion.choices[0].message.content ?? "{}");
    summary = typeof parsed.summary === "string" ? parsed.summary : "";
  } catch {
    summary = "";
  }
  // A code we never sent means the model mixed people up: don't show a wrong name.
  const codes = summary.match(/\bS\d{1,4}\b/g) ?? [];
  if (codes.some((c) => !nameOf.has(c))) {
    console.error("[payroll-ai] summary used an unknown code, falling back:", summary);
    summary = "";
  }
  summary = summary
    .replace(/\bS(\d{1,4})\b/g, (m) => nameOf.get(m) ?? m)
    .replace(/—/g, " - ")
    .trim()
    .slice(0, 400);
  if (!summary) {
    summary = warnings.length ? `${warnings.length} thing${warnings.length === 1 ? "" : "s"} to check before paying.` : "Everything looks ready to pay.";
  }
  return { verdict, summary };
}
