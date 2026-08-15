import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("GET /admin/insights/ai-usage", () => {
  const suffix = `${Date.now()}-insights`;
  let institutionId: string;
  let adminToken: string;
  let teacherId: string;
  let teacherUserId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `AI Insights Test Inst ${suffix}`, email: `ai-insights-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `AIIN-${suffix.slice(-6)}`, userIdPrefix: "AIIN", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
    const teacherUser = await prisma.user.create({
      data: { name: "Insights Teacher", email: `teacher-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    teacherUserId = teacherUser.id;
    const teacher = await prisma.teacher.create({ data: { teacherId: `TIN-${suffix}`, userId: teacherUser.id, institutionId } });
    teacherId = teacher.id;

    await prisma.aiUsageEvent.create({
      data: {
        institutionId, teacherId, userId: teacherUserId, userRole: "TEACHER",
        feature: "BLACKBOARD_SCAN", provider: "groq", model: "llama-3.3-70b-versatile",
        requestType: "chat_completion", totalTokens: 4200, status: "SUCCESS",
      },
    });
  });

  afterAll(async () => {
    await prisma.aiUsageEvent.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("returns per-teacher usage with feature breakdown", async () => {
    const res = await request(app)
      .get("/api/admin/insights/ai-usage")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const row = res.body.data.find((r: { teacherId: string }) => r.teacherId === teacherId);
    expect(row).toBeDefined();
    expect(row.used).toBe(4200);
    expect(row.totalTokens).toBe(4200);
    expect(row.successRequests).toBe(1);
    expect(row.byFeature[0].feature).toBe("BLACKBOARD_SCAN");
  });
});
