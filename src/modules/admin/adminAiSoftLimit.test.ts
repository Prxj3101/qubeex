import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("PATCH /admin/teachers/:id/ai-soft-limit", () => {
  const suffix = `${Date.now()}-softlimit`;
  let institutionId: string;
  let adminToken: string;
  let teacherId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `Soft Limit Test Inst ${suffix}`, email: `soft-limit-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `SFTL-${suffix.slice(-6)}`, userIdPrefix: "SFTL", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
    const teacherUser = await prisma.user.create({
      data: { name: "Test Teacher", email: `teacher-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({ data: { teacherId: `TSL-${suffix}`, userId: teacherUser.id, institutionId } });
    teacherId = teacher.id;
  });

  afterAll(async () => {
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("sets a soft limit", async () => {
    const res = await request(app)
      .patch(`/api/admin/teachers/${teacherId}/ai-soft-limit`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ softLimitTokens: 5_000_000 });

    expect(res.status).toBe(200);
    expect(res.body.data.aiSoftLimitTokens).toBe(5_000_000);

    const updated = await prisma.teacher.findUnique({ where: { id: teacherId } });
    expect(updated?.aiSoftLimitTokens).toBe(5_000_000);
  });

  it("clears a soft limit when sent null", async () => {
    const res = await request(app)
      .patch(`/api/admin/teachers/${teacherId}/ai-soft-limit`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ softLimitTokens: null });

    expect(res.status).toBe(200);
    expect(res.body.data.aiSoftLimitTokens).toBeNull();
  });

  it("rejects a negative limit", async () => {
    const res = await request(app)
      .patch(`/api/admin/teachers/${teacherId}/ai-soft-limit`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ softLimitTokens: -1 });

    expect(res.status).toBe(400);
  });

  it("404s for a teacher not in this institution", async () => {
    const res = await request(app)
      .patch(`/api/admin/teachers/does-not-exist/ai-soft-limit`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ softLimitTokens: 1_000_000 });

    expect(res.status).toBe(404);
  });
});
