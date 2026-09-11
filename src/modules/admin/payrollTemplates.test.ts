import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Salary Template CRUD", () => {
  const suffix = `${Date.now()}-payroll-tpl`;
  let institutionId: string;
  let adminToken: string;

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
  });

  afterAll(async () => {
    await prisma.salaryTemplate.deleteMany({ where: { institutionId } });
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
        earnings: [{ label: "Basic", amount: 30000 }, { label: "HRA", amount: 8000 }],
        deductions: [{ label: "PF", amount: 1200 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Senior Teacher");
    expect(res.body.data.earnings).toHaveLength(2);
    templateId = res.body.data.id;
  });

  it("rejects a duplicate name in the same institution", async () => {
    const res = await request(app)
      .post("/api/admin/payroll/templates")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Senior Teacher", earnings: [{ label: "Basic", amount: 1 }], deductions: [] });
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
      .send({ name: "Senior Teacher", earnings: [{ label: "Basic", amount: 35000 }], deductions: [] });
    expect(res.status).toBe(200);
    expect(res.body.data.earnings[0].amount).toBe(35000);
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
      .send({ name: "X", earnings: [], deductions: [] });
    expect(res.status).toBe(404);
  });
});
