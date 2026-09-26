import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Salary Template CRUD", () => {
  const suffix = `${Date.now()}-payroll-tpl`;
  let institutionId: string;
  let adminToken: string;
  let basicId: string;
  let hraId: string;
  let pfId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `Payroll Tpl Test ${suffix}`, email: `payroll-tpl-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `PYTP-${suffix.slice(-6)}`, userIdPrefix: "PYTP", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
    const basic = await prisma.salaryComponent.create({ data: { institutionId, name: "Basic", type: "EARNING", calcType: "FIXED", isBasic: true } });
    const hra = await prisma.salaryComponent.create({ data: { institutionId, name: "HRA", type: "EARNING", calcType: "PERCENT_OF_BASIC" } });
    const pf = await prisma.salaryComponent.create({ data: { institutionId, name: "PF", type: "DEDUCTION", calcType: "FIXED" } });
    basicId = basic.id; hraId = hra.id; pfId = pf.id;
  });

  afterAll(async () => {
    await prisma.salaryTemplate.deleteMany({ where: { institutionId } });
    await prisma.salaryComponent.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  let templateId: string;

  it("creates a template", async () => {
    const res = await request(app)
      .post("/api/admin/payroll/templates")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Senior Teacher",
        items: [{ componentId: basicId, value: 3000000 }, { componentId: hraId, value: 4000 }, { componentId: pfId, value: 120000 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Senior Teacher");
    expect(res.body.data.items).toHaveLength(3);
    templateId = res.body.data.id;
  });

  it("rejects a duplicate name in the same institution", async () => {
    const res = await request(app)
      .post("/api/admin/payroll/templates")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Senior Teacher", items: [{ componentId: basicId, value: 100 }] });
    expect(res.status).toBe(409);
  });

  it("lists templates for this institution only", async () => {
    const res = await request(app)
      .get("/api/admin/payroll/templates")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { id: string }) => t.id)).toContain(templateId);
  });

  it("updates a template", async () => {
    const res = await request(app)
      .patch(`/api/admin/payroll/templates/${templateId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Senior Teacher", items: [{ componentId: basicId, value: 3500000 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].value).toBe(3500000);
  });

  it("rejects a percentage component without Basic", async () => {
    const res = await request(app)
      .post("/api/admin/payroll/templates")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "No Basic", items: [{ componentId: hraId, value: 4000 }] });
    expect(res.status).toBe(400);
  });

  it("deletes a template", async () => {
    const res = await request(app)
      .delete(`/api/admin/payroll/templates/${templateId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const found = await prisma.salaryTemplate.findUnique({ where: { id: templateId } });
    expect(found).toBeNull();
  });

  it("404s updating a template that doesn't belong to this institution", async () => {
    const res = await request(app)
      .patch(`/api/admin/payroll/templates/does-not-exist`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "X", items: [] });
    expect(res.status).toBe(404);
  });
});
