import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("GET /superadmin/institutions/:id/ai-usage", () => {
  const suffix = `${Date.now()}-sainstusage`;
  let institutionId: string;
  let superAdminToken: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `SA Inst Usage Test ${suffix}`, email: `sa-inst-usage-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `SAIU-${suffix.slice(-6)}`, userIdPrefix: "SAIU", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const superAdminUser = await prisma.user.create({
      data: { name: "Test SuperAdmin", email: `superadmin-${suffix}@example.com`, role: "SUPER_ADMIN", isActive: true },
    });
    superAdminToken = jwt.sign({ userId: superAdminUser.id, role: "SUPER_ADMIN" }, process.env.JWT_SECRET!);
    const teacherUser = await prisma.user.create({
      data: { name: "Usage Teacher", email: `teacher-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });

    await prisma.aiUsageEvent.create({
      data: {
        institutionId, userId: teacherUser.id, userRole: "TEACHER",
        feature: "BLACKBOARD_SCAN", provider: "groq", model: "llama-3.3-70b-versatile",
        requestType: "chat_completion", totalTokens: 777, status: "SUCCESS",
      },
    });
  });

  afterAll(async () => {
    await prisma.aiUsageEvent.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("returns institution-wide usage totals, feature breakdown, and trend — no teacher identifiers", async () => {
    const res = await request(app)
      .get(`/api/superadmin/institutions/${institutionId}/ai-usage`)
      .set("Authorization", `Bearer ${superAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.totalTokens).toBe(777);
    expect(res.body.data.byFeature[0].feature).toBe("BLACKBOARD_SCAN");
    expect(Array.isArray(res.body.data.trend)).toBe(true);
    expect(res.body.data).not.toHaveProperty("byTeacher");
    expect(res.body.data).not.toHaveProperty("teacherId");
  });
});
