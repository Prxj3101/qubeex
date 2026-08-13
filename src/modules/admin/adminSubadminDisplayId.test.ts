import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("GET /admin/subadmins includes displayId", () => {
  let institutionId: string;
  let adminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-SAID-${suffix}`,
        name: "Sri Krishna Public School",
        email: `test-said-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-said-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.invite.deleteMany({ where: { institutionId } });
    await prisma.subAdmin.deleteMany({ where: { institutionId } });
    await prisma.userStatusEvent.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("returns the new-format displayId for a newly created sub-admin", async () => {
    const create = await request(app)
      .post(`/api/admin/subadmins`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Test SubAdmin",
        email: `subadmin-said-${Date.now()}@example.com`,
        designation: "Coordinator",
        permissions: ["CAMPUS_VIEW"],
      });

    expect(create.status).toBe(201);

    const list = await request(app)
      .get(`/api/admin/subadmins`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(list.status).toBe(200);
    const found = list.body.data.find((s: { name: string }) => s.name === "Test SubAdmin");
    expect(found).toBeDefined();
    expect(found.displayId).toMatch(/^SKPS-\d{2}A\d{2}-\d{4}$/);
  });
});
