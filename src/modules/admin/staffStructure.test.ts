import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Staff salary structure", () => {
  const suffix = `${Date.now()}-staff-struct`;
  let institutionId: string;
  let adminToken: string;
  let staffId: string;
  let otherInstitutionId: string;
  let otherStaffId: string;
  let wageId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: { name: `Staff Struct Test ${suffix}`, email: `staff-struct-${suffix}@example.com`, type: "SCHOOL", institutionCode: `SSTR-${suffix.slice(-6)}`, userIdPrefix: "SSTR", status: "ACTIVE" },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({ data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true } });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
    const staff = await prisma.staff.create({ data: { institutionId, name: "Helper Staff", email: `h-${suffix}@example.com`, staffType: "HELPER" } });
    staffId = staff.id;
    const wage = await prisma.salaryComponent.create({ data: { institutionId, name: "Monthly Wage", type: "EARNING", calcType: "FIXED", isBasic: true } });
    wageId = wage.id;

    const otherInst = await prisma.institution.create({
      data: { name: `Other Struct Inst ${suffix}`, email: `other-struct-${suffix}@example.com`, type: "SCHOOL", institutionCode: `OSTR-${suffix.slice(-6)}`, userIdPrefix: "OSTR", status: "ACTIVE" },
    });
    otherInstitutionId = otherInst.id;
    const otherStaff = await prisma.staff.create({ data: { institutionId: otherInstitutionId, name: "Other Helper", email: `oh-${suffix}@example.com`, staffType: "HELPER" } });
    otherStaffId = otherStaff.id;
  });

  afterAll(async () => {
    await prisma.staffSalaryStructure.deleteMany({ where: { institutionId: { in: [institutionId, otherInstitutionId] } } });
    await prisma.salaryComponent.deleteMany({ where: { institutionId } });
    await prisma.staff.deleteMany({ where: { institutionId: { in: [institutionId, otherInstitutionId] } } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.deleteMany({ where: { id: { in: [institutionId, otherInstitutionId] } } });
    await prisma.$disconnect();
  });

  it("returns null before any structure is saved", async () => {
    const res = await request(app).get(`/api/admin/payroll/staff/${staffId}/structure`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.current).toBeNull();
    expect(res.body.data.history).toHaveLength(0);
  });

  it("saves a new structure", async () => {
    const res = await request(app)
      .put(`/api/admin/payroll/staff/${staffId}/structure`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        items: [{ componentId: wageId, value: 1200000 }],
        effectiveFrom: "2026-04-01",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.staffId).toBe(staffId);
    expect(res.body.data.items[0].value).toBe(1200000);
  });

  it("edits the same version when saved again with the same effective date", async () => {
    const res = await request(app)
      .put(`/api/admin/payroll/staff/${staffId}/structure`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ items: [{ componentId: wageId, value: 1300000 }], effectiveFrom: "2026-04-01" });
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].value).toBe(1300000);

    const count = await prisma.staffSalaryStructure.count({ where: { staffId } });
    expect(count).toBe(1);
  });

  it("keeps history: a later effective date adds a new version", async () => {
    const res = await request(app)
      .put(`/api/admin/payroll/staff/${staffId}/structure`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ items: [{ componentId: wageId, value: 1400000 }], effectiveFrom: "2026-06-01", note: "Increment" });
    expect(res.status).toBe(200);

    const count = await prisma.staffSalaryStructure.count({ where: { staffId } });
    expect(count).toBe(2);
  });

  it("404s for a staff member in another institution", async () => {
    const res = await request(app).get(`/api/admin/payroll/staff/${otherStaffId}/structure`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);

    const putRes = await request(app)
      .put(`/api/admin/payroll/staff/${otherStaffId}/structure`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ items: [{ componentId: wageId, value: 100 }], effectiveFrom: "2026-04-01" });
    expect(putRes.status).toBe(404);
  });
});
