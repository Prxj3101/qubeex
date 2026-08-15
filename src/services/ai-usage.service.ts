import { prisma } from "../utils/prisma";
import { redis, isRedisReady } from "../utils/redis";

export type AiFeature =
  | "BLACKBOARD_CONTEXT"
  | "BLACKBOARD_SCAN"
  | "BLACKBOARD_CHAT"
  | "BLACKBOARD_QUIZ"
  | "TASK_QUESTION_GENERATION";

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
  await redis.incrby(`ai:usage:institution:${params.institutionId}`, tokens).catch(() => {});
  if (params.teacherId) {
    await redis.incrby(`ai:usage:teacher:${params.teacherId}`, tokens).catch(() => {});
  }
}
