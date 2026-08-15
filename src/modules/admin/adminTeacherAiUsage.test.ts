import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("GET /admin/teachers/:id/ai-usage", () => {
  const suffix = `${Date.now()}-teacherusage`;
  let institutionId: string;
  let adminToken: string;
  let teacherId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `Teacher Usage Test Inst ${suffix}`, email: `teacher-usage-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `TCHU-${suffix.slice(-6)}`, userIdPrefix: "TCHU", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
    const teacherUser = await prisma.user.create({
      data: { name: "Detail Teacher", email: `teacher-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({ data: { teacherId: `TDT-${suffix}`, userId: teacherUser.id, institutionId } });
    teacherId = teacher.id;

    await prisma.aiUsageEvent.create({
      data: {
        institutionId, teacherId, userId: teacherUser.id, userRole: "TEACHER",
        feature: "BLACKBOARD_QUIZ", provider: "groq", model: "llama-3.3-70b-versatile",
        requestType: "chat_completion", totalTokens: 900, status: "SUCCESS",
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

  it("returns single-teacher usage detail with pool share and trend", async () => {
    const res = await request(app)
      .get(`/api/admin/teachers/${teacherId}/ai-usage`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.totalTokens).toBe(900);
    expect(res.body.data.institutionPoolLimit).toBeGreaterThan(0);
    expect(res.body.data.poolSharePct).toBeGreaterThan(0);
    expect(Array.isArray(res.body.data.trend)).toBe(true);
    // No admin override was set for this teacher: the effective limit is still
    // reported (a computed even-split default), but the override must be null
    // so the UI doesn't render a phantom "limit is set" state.
    expect(res.body.data.softLimitOverride).toBeNull();
    expect(res.body.data.softLimitTokens).toBeGreaterThan(0);
  });

  it("404s for a teacher outside the caller's institution", async () => {
    const res = await request(app)
      .get(`/api/admin/teachers/does-not-exist/ai-usage`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
