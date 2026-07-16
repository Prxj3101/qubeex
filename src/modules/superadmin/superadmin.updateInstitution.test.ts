import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("PUT /superadmin/institutions/:id — Institution Info + Location sections", () => {
  let superAdminToken: string;
  let institutionId: string;
  const suffix = `${Date.now()}`;

  beforeAll(async () => {
    const superAdminUser = await prisma.user.create({
      data: { name: "Test SuperAdmin", email: `superadmin-ui-${suffix}@example.com`, role: "SUPER_ADMIN", isActive: true },
    });
    superAdminToken = jwt.sign({ userId: superAdminUser.id, role: "SUPER_ADMIN" }, process.env.JWT_SECRET!);

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-UI-${suffix}`,
        name: "Original Institution Name",
        email: `inst-ui-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.user.deleteMany({ where: { email: { contains: `-ui-${suffix}@example.com` } } });
    await prisma.$disconnect();
  });

  it("persists Institution Info fields (name, email, phone, board, medium, establishedOn)", async () => {
    const res = await request(app)
      .put(`/api/superadmin/institutions/${institutionId}`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({
        name: "Renamed Institution",
        email: `renamed-inst-ui-${suffix}@example.com`,
        phone: "+91 22 1234 5678",
        board: "CBSE",
        medium: "English",
        establishedOn: "1998-04-12",
      });

    expect(res.status).toBe(200);

    const updated = await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });
    expect(updated.name).toBe("Renamed Institution");
    expect(updated.email).toBe(`renamed-inst-ui-${suffix}@example.com`);
    expect(updated.phone).toBe("+91 22 1234 5678");
    expect(updated.board).toBe("CBSE");
    expect(updated.medium).toBe("English");
    expect(updated.establishedOn).toBe("1998-04-12");
  });

  it("persists Location fields (address, city, state, country, pincode)", async () => {
    const res = await request(app)
      .put(`/api/superadmin/institutions/${institutionId}`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({
        address: "123 MG Road",
        city: "Bengaluru",
        state: "Karnataka",
        country: "India",
        pincode: "560001",
      });

    expect(res.status).toBe(200);

    const updated = await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });
    expect(updated.address).toBe("123 MG Road");
    expect(updated.city).toBe("Bengaluru");
    expect(updated.state).toBe("Karnataka");
    expect(updated.country).toBe("India");
    expect(updated.pincode).toBe("560001");
  });
});
