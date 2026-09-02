import { prisma } from "../utils/prisma";
import { redis } from "../utils/redis";
import { recordAiUsage, institutionUsageRedisKey, teacherUsageRedisKey } from "./ai-usage.service";
import {
  rangeToFromDate, bucketGranularity, bucketEvents, computeSoftLimitDefault,
  getTeacherUsageSummary, getInstitutionTeacherBreakdown, getInstitutionUsageSummary, getPlatformUsageSummary,
} from "./ai-usage.service";

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
    await redis?.del(institutionUsageRedisKey(institutionId));
    await prisma.$disconnect();
  });

  it("inserts an AiUsageEvent row and increments the institution Redis counter on SUCCESS", async () => {
    const before = Number((await redis?.get(institutionUsageRedisKey(institutionId))) ?? 0);

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

    const after = Number((await redis?.get(institutionUsageRedisKey(institutionId))) ?? 0);
    expect(after - before).toBe(150);
  });

  it("inserts a FAILED event with an error message and does NOT increment Redis", async () => {
    const before = Number((await redis?.get(institutionUsageRedisKey(institutionId))) ?? 0);

    await recordAiUsage({
      institutionId, userId, userRole: "TEACHER",
      feature: "BLACKBOARD_CHAT", provider: "groq", model: "llama-3.3-70b-versatile",
      requestType: "chat_completion", status: "FAILED", error: "rate limit exceeded",
    });

    const failed = await prisma.aiUsageEvent.findFirst({ where: { institutionId, status: "FAILED" } });
    expect(failed?.error).toBe("rate limit exceeded");
    expect(failed?.totalTokens).toBeNull();

    const after = Number((await redis?.get(institutionUsageRedisKey(institutionId))) ?? 0);
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

    const teacherUsage = Number((await redis?.get(teacherUsageRedisKey(teacher.id))) ?? 0);
    expect(teacherUsage).toBe(200);

    await prisma.teacher.delete({ where: { id: teacher.id } });
    await redis?.del(teacherUsageRedisKey(teacher.id));
  });
});

describe("date range helpers", () => {
  it("rangeToFromDate returns a date in the past for each supported range", () => {
    const now = Date.now();
    expect(rangeToFromDate("7D").getTime()).toBeLessThan(now);
    expect(rangeToFromDate("1M").getTime()).toBeLessThan(rangeToFromDate("7D").getTime());
    expect(rangeToFromDate("YTD").getFullYear()).toBe(new Date().getFullYear());
  });

  it("bucketGranularity is day for short ranges, month for long ones", () => {
    expect(bucketGranularity("7D")).toBe("day");
    expect(bucketGranularity("1M")).toBe("day");
    expect(bucketGranularity("3M")).toBe("month");
    expect(bucketGranularity("6M")).toBe("month");
    expect(bucketGranularity("YTD")).toBe("month");
  });

  it("bucketEvents groups by day correctly", () => {
    const points = bucketEvents(
      [
        { createdAt: new Date("2026-08-01T10:00:00Z"), totalTokens: 100 },
        { createdAt: new Date("2026-08-01T14:00:00Z"), totalTokens: 50 },
        { createdAt: new Date("2026-08-02T10:00:00Z"), totalTokens: 200 },
      ],
      "day"
    );
    expect(points).toEqual([
      { period: "2026-08-01", requests: 2, totalTokens: 150 },
      { period: "2026-08-02", requests: 1, totalTokens: 200 },
    ]);
  });

  it("buckets by the IST calendar day, not the UTC day", () => {
    // 2026-08-01T20:00Z is already 01:30 on 2026-08-02 in IST.
    const points = bucketEvents([{ createdAt: new Date("2026-08-01T20:00:00Z"), totalTokens: 10 }], "day");
    expect(points).toEqual([{ period: "2026-08-02", requests: 1, totalTokens: 10 }]);
  });

  it("zero-fills gaps across the requested range instead of omitting empty days", () => {
    const points = bucketEvents(
      [
        { createdAt: new Date("2026-08-01T10:00:00Z"), totalTokens: 100 },
        { createdAt: new Date("2026-08-04T10:00:00Z"), totalTokens: 200 },
      ],
      "day",
      new Date("2026-07-31T10:00:00Z"),
      new Date("2026-08-05T10:00:00Z")
    );
    expect(points.map(p => p.period)).toEqual([
      "2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05",
    ]);
    expect(points.find(p => p.period === "2026-08-02")).toEqual({ period: "2026-08-02", requests: 0, totalTokens: 0 });
  });

  it("zero-fills month buckets too", () => {
    const points = bucketEvents(
      [{ createdAt: new Date("2026-03-10T10:00:00Z"), totalTokens: 5 }],
      "month",
      new Date("2026-01-10T10:00:00Z"),
      new Date("2026-04-10T10:00:00Z")
    );
    expect(points.map(p => p.period)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
  });

  it("does not explode into thousands of buckets for an all-time range", () => {
    const points = bucketEvents(
      [{ createdAt: new Date("2026-08-01T10:00:00Z"), totalTokens: 1 }],
      "day",
      new Date(0),
      new Date("2026-08-02T10:00:00Z")
    );
    expect(points.length).toBeLessThanOrEqual(2);
  });
});

describe("computeSoftLimitDefault", () => {
  it("splits the institution pool evenly across teachers", () => {
    // 10,000,000 pool ÷ 5 teachers = 2,000,000 tokens each, on the same monthly
    // scale as the UI's soft-limit slider.
    expect(computeSoftLimitDefault(10_000_000, 5)).toBe(2_000_000);
  });

  it("returns 0 when there are no teachers", () => {
    expect(computeSoftLimitDefault(10_000_000, 0)).toBe(0);
  });
});

describe("aggregation queries", () => {
  const suffix = `${Date.now()}-agg`;
  let institutionId: string;
  let userId: string;
  let teacherAId: string;
  let teacherBId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `AI Agg Test Inst ${suffix}`, email: `ai-agg-test-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `AIAG-${suffix.slice(-6)}`, userIdPrefix: "AIAG", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const user = await prisma.user.create({
      data: { name: "AI Agg Test User", email: `ai-agg-user-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    userId = user.id;
    const teacherA = await prisma.teacher.create({ data: { teacherId: `TA-${suffix}`, userId, institutionId } });
    const userB = await prisma.user.create({
      data: { name: "AI Agg Test User B", email: `ai-agg-user-b-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacherB = await prisma.teacher.create({ data: { teacherId: `TB-${suffix}`, userId: userB.id, institutionId } });
    teacherAId = teacherA.id;
    teacherBId = teacherB.id;

    await prisma.aiUsageEvent.createMany({
      data: [
        { institutionId, teacherId: teacherAId, userId, userRole: "TEACHER", feature: "BLACKBOARD_SCAN", provider: "groq", model: "llama-3.3-70b-versatile", requestType: "chat_completion", totalTokens: 1000, status: "SUCCESS" },
        { institutionId, teacherId: teacherAId, userId, userRole: "TEACHER", feature: "BLACKBOARD_CHAT", provider: "groq", model: "llama-3.3-70b-versatile", requestType: "chat_completion", status: "FAILED", error: "boom" },
        { institutionId, teacherId: teacherBId, userId: userB.id, userRole: "TEACHER", feature: "TASK_QUESTION_GENERATION", provider: "groq", model: "llama-3.3-70b-versatile", requestType: "chat_completion", totalTokens: 500, status: "SUCCESS" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.aiUsageEvent.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000);

  it("getTeacherUsageSummary aggregates one teacher's events correctly", async () => {
    const summary = await getTeacherUsageSummary(institutionId, teacherAId, from, to);
    expect(summary.totalRequests).toBe(2);
    expect(summary.successRequests).toBe(1);
    expect(summary.failedRequests).toBe(1);
    expect(summary.totalTokens).toBe(1000);
    expect(summary.byFeature.find(f => f.feature === "BLACKBOARD_SCAN")?.totalTokens).toBe(1000);
    // No admin override was ever set for this teacher, so the override is null
    // even though an effective (computed default) limit is still reported.
    expect(summary.softLimitOverride).toBeNull();
    expect(summary.softLimitTokens).toBeGreaterThan(0);
  });

  it("reports softLimitOverride verbatim once an admin sets one", async () => {
    await prisma.teacher.update({ where: { id: teacherAId }, data: { aiSoftLimitTokens: 777_000 } });
    try {
      const summary = await getTeacherUsageSummary(institutionId, teacherAId, from, to);
      expect(summary.softLimitOverride).toBe(777_000);
      expect(summary.softLimitTokens).toBe(777_000);
    } finally {
      await prisma.teacher.update({ where: { id: teacherAId }, data: { aiSoftLimitTokens: null } });
    }
  });

  it("getInstitutionTeacherBreakdown returns one summary per teacher with events", async () => {
    const breakdown = await getInstitutionTeacherBreakdown(institutionId, from, to);
    expect(breakdown.map(t => t.teacherId).sort()).toEqual([teacherAId, teacherBId].sort());
  });

  it("getInstitutionUsageSummary aggregates across all teachers", async () => {
    const summary = await getInstitutionUsageSummary(institutionId, "1M");
    expect(summary.totalRequests).toBe(3);
    expect(summary.totalTokens).toBe(1500);
    expect(summary.byFeature).toHaveLength(3);
  });

  it("getPlatformUsageSummary includes this institution in byInstitution with no teacher-level data", async () => {
    const summary = await getPlatformUsageSummary("1M");
    const row = summary.byInstitution.find(i => i.institutionId === institutionId);
    expect(row).toBeDefined();
    expect(row?.requests).toBe(3);
    expect(row?.totalTokens).toBe(1500);
    // No teacher identifiers should exist anywhere on the platform summary shape.
    expect(JSON.stringify(summary)).not.toContain(teacherAId);
  });
});
