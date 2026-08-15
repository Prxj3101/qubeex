import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("GET /superadmin/system/ai-usage", () => {
  const suffix = `${Date.now()}-platformusage`;
  let institutionId: string;
  let superAdminToken: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `Platform Usage Test ${suffix}`, email: `platform-usage-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `PLTU-${suffix.slice(-6)}`, userIdPrefix: "PLTU", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const superAdminUser = await prisma.user.create({
      data: { name: "Test SuperAdmin", email: `superadmin-${suffix}@example.com`, role: "SUPER_ADMIN", isActive: true },
    });
    superAdminToken = jwt.sign({ userId: superAdminUser.id, role: "SUPER_ADMIN" }, process.env.JWT_SECRET!);
    const teacherUser = await prisma.user.create({
      data: { name: "Platform Teacher", email: `teacher-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });

    await prisma.aiUsageEvent.create({
      data: {
        institutionId, userId: teacherUser.id, userRole: "TEACHER",
        feature: "BLACKBOARD_CHAT", provider: "groq", model: "llama-3.3-70b-versatile",
        requestType: "chat_completion", totalTokens: 333, status: "SUCCESS",
      },
    });
  });

  afterAll(async () => {
    await prisma.aiUsageEvent.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("returns real platform totals including this institution, no teacher identifiers", async () => {
    const res = await request(app)
      .get("/api/superadmin/system/ai-usage")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .query({ range: "1M" });

    expect(res.status).toBe(200);
    expect(res.body.data.summary.totalTokens).toBeGreaterThanOrEqual(333);
    const row = res.body.data.perInstitution.find((i: { institutionId: string }) => i.institutionId === institutionId);
    expect(row).toBeDefined();
    expect(row.totalTokens).toBe(333);
    expect(res.body.data).not.toHaveProperty("byTeacher");
  });
});
