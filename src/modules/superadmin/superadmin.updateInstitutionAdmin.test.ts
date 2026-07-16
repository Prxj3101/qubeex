import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("PATCH /superadmin/institutions/:id/admin", () => {
  let superAdminToken: string;
  let institutionId: string;
  let adminUserId: string;
  const suffix = `${Date.now()}`;

  beforeAll(async () => {
    const superAdminUser = await prisma.user.create({
      data: { name: "Test SuperAdmin", email: `superadmin-uia-${suffix}@example.com`, role: "SUPER_ADMIN", isActive: true },
    });
    superAdminToken = jwt.sign({ userId: superAdminUser.id, role: "SUPER_ADMIN" }, process.env.JWT_SECRET!);

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-UIA-${suffix}`,
        name: "Test Institution UIA",
        email: `inst-uia-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const adminUser = await prisma.user.create({
      data: { name: "Original Admin", email: `admin-uia-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminUserId = adminUser.id;
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.user.deleteMany({ where: { email: { contains: `-uia-${suffix}@example.com` } } });
    await prisma.$disconnect();
  });

  it("updates the admin's real User.name and User.email (login credential), plus Institution.admin* fields", async () => {
    const res = await request(app)
      .patch(`/api/superadmin/institutions/${institutionId}/admin`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({
        adminName: "Renamed Admin",
        adminEmail: `renamed-admin-uia-${suffix}@example.com`,
        adminPhone: "+91 98765 43210",
        adminDob: "1990-01-01",
        adminGender: "Male",
        adminPrefix: "Mr.",
        adminTitle: "Principal",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      adminName: "Renamed Admin",
      adminEmail: `renamed-admin-uia-${suffix}@example.com`,
      adminPhone: "+91 98765 43210",
      adminDob: "1990-01-01",
      adminGender: "Male",
      adminPrefix: "Mr.",
      adminTitle: "Principal",
    });

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } });
    expect(updatedUser.name).toBe("Renamed Admin");
    expect(updatedUser.email).toBe(`renamed-admin-uia-${suffix}@example.com`);

    const updatedInstitution = await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });
    expect(updatedInstitution.adminPhone).toBe("+91 98765 43210");
    expect(updatedInstitution.adminDob).toBe("1990-01-01");
    expect(updatedInstitution.adminGender).toBe("Male");
    expect(updatedInstitution.adminPrefix).toBe("Mr.");
    expect(updatedInstitution.adminTitle).toBe("Principal");
  });

  it("rejects an email already used by another user", async () => {
    const otherSuffix = `${Date.now()}-2`;
    const otherUser = await prisma.user.create({
      data: { name: "Other User", email: `other-uia-${otherSuffix}@example.com`, role: "TEACHER", isActive: true },
    });

    const res = await request(app)
      .patch(`/api/superadmin/institutions/${institutionId}/admin`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({ adminEmail: otherUser.email });

    expect(res.status).toBe(409);

    await prisma.user.delete({ where: { id: otherUser.id } });
  });

  it("404s for a non-existent institution", async () => {
    const res = await request(app)
      .patch(`/api/superadmin/institutions/00000000-0000-0000-0000-000000000000/admin`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({ adminName: "Someone" });

    expect(res.status).toBe(404);
  });
});
