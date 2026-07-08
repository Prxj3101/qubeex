import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("GET /admin/campus/divisions/:divisionId/students — permission widening", () => {
  let institutionId: string;
  let divisionId: string;
  let subAdminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-DS-${suffix}`,
        name: `Test Institution DS ${suffix}`,
        email: `test-ds-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class DS ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    divisionId = division.id;

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-ds-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    const subAdminUser = await prisma.user.create({
      data: { name: "Test SubAdmin", email: `subadmin-ds-${suffix}@example.com`, role: "SUB_ADMIN", institutionId, isActive: true },
    });
    await prisma.subAdmin.create({
      data: { userId: subAdminUser.id, institutionId, permissions: ["CAMPUS_MANAGE"], createdById: adminUser.id },
    });

    subAdminToken = jwt.sign({ userId: subAdminUser.id, role: "SUB_ADMIN", institutionId }, process.env.JWT_SECRET!);
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.subAdmin.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("allows a sub-admin with only CAMPUS_MANAGE (no CAMPUS_ATTENDANCE) to list division students", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/students`)
      .set("Authorization", `Bearer ${subAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
