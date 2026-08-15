import { prisma } from "../utils/prisma";
import { redis } from "../utils/redis";
import { recordAiUsage } from "./ai-usage.service";

describe("recordAiUsage", () => {
  const suffix = `${Date.now()}`;
  let institutionId: string;
  let userId: string;

  beforeAll(async () => {
    const plan = await prisma.plan.findFirst({ where: { name: "TRIAL" } });
    const institution = await prisma.institution.create({
      data: {
        name: `AI Usage Test Inst ${suffix}`,
        email: `ai-usage-test-${suffix}@example.com`,
        type: "SCHOOL",
        institutionCode: `AIUT-${suffix.slice(-6)}`,
        userIdPrefix: "AIUT",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const user = await prisma.user.create({
      data: { name: "AI Usage Test User", email: `ai-usage-user-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    userId = user.id;
    void plan;
  });

  afterAll(async () => {
    await prisma.aiUsageEvent.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await redis?.del(`ai:usage:institution:${institutionId}`);
    await prisma.$disconnect();
  });

  it("inserts an AiUsageEvent row and increments the institution Redis counter on SUCCESS", async () => {
    const before = Number((await redis?.get(`ai:usage:institution:${institutionId}`)) ?? 0);

    await recordAiUsage({
      institutionId, userId, userRole: "TEACHER",
      feature: "BLACKBOARD_SCAN", provider: "groq", model: "llama-3.3-70b-versatile",
      requestType: "chat_completion", inputTokens: 100, outputTokens: 50, totalTokens: 150,
      status: "SUCCESS",
    });

    const events = await prisma.aiUsageEvent.findMany({ where: { institutionId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      feature: "BLACKBOARD_SCAN", provider: "groq", status: "SUCCESS", totalTokens: 150,
    });

    const after = Number((await redis?.get(`ai:usage:institution:${institutionId}`)) ?? 0);
    expect(after - before).toBe(150);
  });

  it("inserts a FAILED event with an error message and does NOT increment Redis", async () => {
    const before = Number((await redis?.get(`ai:usage:institution:${institutionId}`)) ?? 0);

    await recordAiUsage({
      institutionId, userId, userRole: "TEACHER",
      feature: "BLACKBOARD_CHAT", provider: "groq", model: "llama-3.3-70b-versatile",
      requestType: "chat_completion", status: "FAILED", error: "rate limit exceeded",
    });

    const failed = await prisma.aiUsageEvent.findFirst({ where: { institutionId, status: "FAILED" } });
    expect(failed?.error).toBe("rate limit exceeded");
    expect(failed?.totalTokens).toBeNull();

    const after = Number((await redis?.get(`ai:usage:institution:${institutionId}`)) ?? 0);
    expect(after).toBe(before);
  });

  it("also increments the per-teacher Redis counter when teacherId is provided", async () => {
    const teacher = await prisma.teacher.create({
      data: { teacherId: `T-${suffix}`, userId, institutionId },
    });

    await recordAiUsage({
      institutionId, teacherId: teacher.id, userId, userRole: "TEACHER",
      feature: "TASK_QUESTION_GENERATION", provider: "groq", model: "llama-3.3-70b-versatile",
      requestType: "chat_completion", totalTokens: 200, status: "SUCCESS",
    });

    const teacherUsage = Number((await redis?.get(`ai:usage:teacher:${teacher.id}`)) ?? 0);
    expect(teacherUsage).toBe(200);

    await prisma.teacher.delete({ where: { id: teacher.id } });
    await redis?.del(`ai:usage:teacher:${teacher.id}`);
  });
});
