// ── AI School PA — the assistant itself ─────────────────────────────────────
// A tool-calling chat: the model can call any of SCHOOL_ASSISTANT_TOOLS to
// pull real numbers about the admin's own institution, then answers in plain
// language. Capped at ONE tool round-trip (the model may call several tools
// in that single round, but never gets a second chance to call more after
// seeing their results) — this bounds every question to at most 2 real
// completions, keeping cost predictable regardless of how many tools the
// model reaches for.
import { getInstitutionAiTokenLimit, getInstitutionPoolUsed, recordAiUsage, type AiFeature } from "./ai-usage.service";
import { SCHOOL_ASSISTANT_TOOLS, SCHOOL_ASSISTANT_EXECUTORS } from "./schoolAssistantTools.service";
import { prisma } from "../utils/prisma";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpenAIModule = (process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY) ? require("openai") : null;
const openai: import("openai").OpenAI | null = OpenAIModule
  ? new OpenAIModule.OpenAI(
      process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : { apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" }
    )
  : null;
const ASSISTANT_MODEL = process.env.OPENAI_API_KEY ? "gpt-4.1-mini" : "openai/gpt-oss-120b";
const ASSISTANT_PROVIDER: "openai" | "groq" = process.env.OPENAI_API_KEY ? "openai" : "groq";
const ASSISTANT_FEATURE = "SCHOOL_ASSISTANT" as AiFeature;

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT =
  "You are Jarvis — a sharp, friendly personal assistant embedded in a school admin's analytics dashboard, and you know this institution the way a real PA would: its staff (admin, sub-admins, teachers, who teaches what), its class structure, its students, its calendar, its attendance, its fee collection, parent engagement, and staff AI usage — but ONLY for this one institution, never anything outside it. " +
  "Always call a tool to get real data before answering any question that depends on institution facts — never guess or make up names, numbers, or details. " +
  "You have several tools available for different domains (staff directory, class structure, a specific student, attendance, fees, fee defaulters by class, parent engagement, AI usage, holidays, the campus feed/announcements, and calendar events) — pick whichever ones the question actually needs, and call more than one at once if the question spans domains (e.g. 'who teaches my top-attendance class'). " +
  "If a question needs data no tool provides, say plainly that you don't have access to that yet, rather than inventing an answer. " +
  "This also applies across turns: if an earlier question in this conversation never got a real, tool-backed answer (it errored, or no tool was called for it), do NOT retroactively answer it from memory or a guess later in the conversation, even if the current message doesn't call for a tool itself — only ever state institution facts you actually pulled via a tool in that same turn. " +
  "Lead with the headline number/fact, then back it up with structure — this is a chat panel, so favor scannable formatting over dense paragraphs. " +
  "Use short bold headings/subheadings (## or **text**) to break up multi-part answers, **bold** for key numbers and names, bulleted or numbered lists when enumerating anything, and a well-chosen emoji per heading or list item to make it easy to scan at a glance (📋 attendance, 💰 fees, 👨‍🏫 staff, 🏫 classes, 👨‍👩‍👧 parents, 🤖 AI usage, 📅 holidays, ⚠️ something needing attention). " +
  "For a single quick fact, a short sentence or two is enough — save the full heading/bullet treatment for answers with multiple parts or numbers to compare. " +
  "NEVER use a markdown table (no | pipe characters or --- separator rows) — this chat panel can't render them and it'll show up as broken, garbled text. For any ranking, comparison, or row-of-values data (e.g. 'who used the most tokens'), use a numbered or bulleted list instead, one item per person/row, with the key numbers **bolded** inline. " +
  "Keep it purposeful, never gimmicky: only structure things that actually have parts, and only emoji where they help the eye land, not on every line. " +
  "Be warm and a little witty, like a capable colleague — never robotic or overly formal.";

export interface AssistantResult {
  reply: string;
  tokenLimitReached?: boolean;
}

// ── Keyword-based tool pre-filter ───────────────────────────────────────────
// Every question pays a fixed token cost just for the tool schemas the model
// sees, regardless of which it calls — that cost scales with how many tools
// exist, and it now stands at a dozen. Rather than trim the tool set itself,
// this does a cheap, local keyword match on the question to send only the
// tools that plausibly apply, before the request goes anywhere. It's a plain
// substring check, not a model call, so it costs nothing and adds no latency.
// Deliberately conservative: any question that doesn't clearly match a
// domain falls back to the FULL tool list, so an ambiguous or oddly-phrased
// question never silently loses access to a tool it needed — this only
// saves tokens on the (common) case of an obviously single-topic question.
const TOOL_KEYWORDS: Record<string, string[]> = {
  getAttendanceOverview: ["attendance", "present", "absent", "absentee"],
  getFeeOverview: ["fee", "fees", "collection", "payment", "paid", "dues", "due"],
  getFeeDefaultersByClass: ["fee", "fees", "pending", "unpaid", "due", "defaulter"],
  getDisengagedParents: ["parent", "parents", "engagement", "disengaged", "family", "families"],
  getStaffAiUsage: ["ai usage", "ai tool", "blackboard", "token", "tokens"],
  getInstitutionProfile: ["institution", "school profile", "board", "medium", "address", "established", "about the school", "about our school"],
  getStaffDirectory: ["teacher", "teachers", "admin", "sub-admin", "subadmin", "staff", "teaches", "designation", "principal"],
  getClassStructure: ["class", "standard", "division", "section", "subject", "subjects", "grade"],
  getStudentLookup: ["student", "roll", "roll no", "rollno"],
  getUpcomingHolidays: ["holiday", "holidays", "vacation", "leave day"],
  getRecentCampusFeedPosts: ["feed", "post", "posts", "announcement", "notice", "notices"],
  getUpcomingCalendarEvents: ["calendar", "event", "events", "ptm", "exam schedule", "function", "upcoming"],
};

// Plain greetings/small talk never need a tool at all — matching them here
// means "hii" costs zero tool-schema tokens instead of either 1 (a bad
// keyword guess) or all 12 (the ambiguous-question fallback below).
const SMALL_TALK = /^\s*(hi+|hello+|hey+|yo|sup|thanks?|thank\s*you|thx|ok(ay)?|cool|nice|great|good\s*(morning|afternoon|evening)|bye|good\s*bye)[!.? ]*\s*$/i;

function pickRelevantTools(question: string, isFirstMessage: boolean): typeof SCHOOL_ASSISTANT_TOOLS {
  const trimmed = question.trim();
  // Only skip tools for a greeting when it's the very first thing said in
  // the chat. Mid-conversation, an earlier turn may still need answering
  // (e.g. a prior question that errored out) — dropping tools there once
  // let the model "helpfully" invent a plausible-sounding but made-up
  // answer instead of admitting it had nothing to go on. Never worth the
  // token saving.
  if (isFirstMessage && SMALL_TALK.test(trimmed)) return [];

  const q = trimmed.toLowerCase();
  const matched = SCHOOL_ASSISTANT_TOOLS.filter((t) => (TOOL_KEYWORDS[t.name] ?? []).some((kw) => q.includes(kw)));
  // No confident match on a real (non-greeting) question — safest to hand
  // over every tool rather than guess wrong and miss one it actually needed.
  return matched.length > 0 ? matched : SCHOOL_ASSISTANT_TOOLS;
}

export async function askSchoolAssistant(
  messages: AssistantMessage[],
  ctx: { institutionId: string; userId: string; userRole: string }
): Promise<AssistantResult> {
  if (!openai) {
    return { reply: "The AI School PA isn't configured on this server yet — ask your platform admin to add an AI provider key." };
  }

  const [used, limit] = await Promise.all([
    getInstitutionPoolUsed(ctx.institutionId).catch(() => 0),
    getInstitutionAiTokenLimit(ctx.institutionId).catch(() => 0),
  ]);
  if (limit > 0 && used >= limit) {
    return { reply: "This school's monthly AI token pool is used up, so I can't look anything up right now — it resets next month.", tokenLimitReached: true };
  }

  const userMessages = messages.filter((m) => m.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1]?.content ?? "";
  const relevantTools = pickRelevantTools(lastUserMessage, userMessages.length <= 1);
  const tools = relevantTools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  // The person actually chatting is already known server-side (no tool call
  // needed, no hallucination risk) — without this, "what's my name?" had no
  // tool that could answer it and the model either guessed or refused.
  const requester = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }).catch(() => null);
  const identityLine = requester?.name
    ? `\n\nThe person you're chatting with right now is ${requester.name}, this institution's admin — you already know this, no tool call needed if they ask about themselves (their own name/role).`
    : "";

  const chatMessages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; tool_calls?: unknown[] }> = [
    { role: "system", content: SYSTEM_PROMPT + identityLine },
    ...messages,
  ];

  let firstCompletion;
  try {
    firstCompletion = await openai.chat.completions.create({
      model: ASSISTANT_MODEL,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: chatMessages as any,
      // Omit `tools` entirely for plain small talk — some providers reject
      // an empty tools array outright, and there's nothing to call anyway.
      ...(tools.length > 0 ? { tools } : {}),
      max_tokens: 400,
      ...(ASSISTANT_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
    });
  } catch (err) {
    await recordAiUsage({
      institutionId: ctx.institutionId, userId: ctx.userId, userRole: ctx.userRole,
      feature: ASSISTANT_FEATURE, provider: ASSISTANT_PROVIDER, model: ASSISTANT_MODEL,
      requestType: "chat_completion", status: "FAILED", error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await recordAiUsage({
    institutionId: ctx.institutionId, userId: ctx.userId, userRole: ctx.userRole,
    feature: ASSISTANT_FEATURE, provider: ASSISTANT_PROVIDER, model: ASSISTANT_MODEL,
    requestType: "chat_completion", status: "SUCCESS",
    inputTokens: firstCompletion.usage?.prompt_tokens, outputTokens: firstCompletion.usage?.completion_tokens,
    totalTokens: firstCompletion.usage?.total_tokens,
  });

  const firstMessage = firstCompletion.choices[0].message;
  const toolCalls = firstMessage.tool_calls;

  if (!toolCalls || toolCalls.length === 0) {
    return { reply: firstMessage.content ?? "" };
  }

  // Run every requested tool (scoped to institutionId, never anything the
  // model supplies) and feed the results back for one final answer.
  const toolResultMessages = await Promise.all(
    toolCalls.map(async (call) => {
      const executor = SCHOOL_ASSISTANT_EXECUTORS[call.function.name];
      let resultJson: string;
      try {
        let args: Record<string, unknown> = {};
        try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { /* malformed args from the model — proceed with none */ }
        const result = executor ? await executor(ctx.institutionId, args) : { error: "Unknown tool" };
        resultJson = JSON.stringify(result);
      } catch (err) {
        resultJson = JSON.stringify({ error: err instanceof Error ? err.message : "Tool execution failed" });
      }
      return { role: "tool" as const, tool_call_id: call.id, content: resultJson };
    })
  );

  const followUpMessages = [
    ...chatMessages,
    { role: "assistant" as const, content: firstMessage.content ?? "", tool_calls: firstMessage.tool_calls },
    ...toolResultMessages,
  ];

  let secondCompletion;
  try {
    secondCompletion = await openai.chat.completions.create({
      model: ASSISTANT_MODEL,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: followUpMessages as any,
      max_tokens: 550,
      ...(ASSISTANT_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
    });
  } catch (err) {
    await recordAiUsage({
      institutionId: ctx.institutionId, userId: ctx.userId, userRole: ctx.userRole,
      feature: ASSISTANT_FEATURE, provider: ASSISTANT_PROVIDER, model: ASSISTANT_MODEL,
      requestType: "chat_completion", status: "FAILED", error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await recordAiUsage({
    institutionId: ctx.institutionId, userId: ctx.userId, userRole: ctx.userRole,
    feature: ASSISTANT_FEATURE, provider: ASSISTANT_PROVIDER, model: ASSISTANT_MODEL,
    requestType: "chat_completion", status: "SUCCESS",
    inputTokens: secondCompletion.usage?.prompt_tokens, outputTokens: secondCompletion.usage?.completion_tokens,
    totalTokens: secondCompletion.usage?.total_tokens,
  });

  return { reply: secondCompletion.choices[0].message.content ?? "" };
}
