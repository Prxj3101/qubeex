import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Payslip editing within a draft run", () => {
  const suffix = `${Date.now()}-payroll-edit`;
  let institutionId: string;
  let adminToken: string;
  let staffId: string;
  let runId: string;
  let payslipId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `Payroll Edit Test ${suffix}`, email: `payroll-edit-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `PYED-${suffix.slice(-6)}`, userIdPrefix: "PYED", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
    const staff = await prisma.staff.create({ data: { institutionId, name: "Test Staff", email: `t-${suffix}@example.com`, staffType: "HELPER" } });
    staffId = staff.id;

    const run = await prisma.payrollRun.create({ data: { institutionId, month: "2026-11", status: "DRAFT" } });
    runId = run.id;
    const payslip = await prisma.payslip.create({
      data: { payrollRunId: runId, staffId, staffName: staff.name, staffEmail: staff.email, institutionId, earnings: [{ label: "Basic", amount: 10000 }], deductions: [], grossPay: 10000, netPay: 10000 },
    });
    payslipId = payslip.id;
  });

  afterAll(async () => {
    await prisma.payslip.deleteMany({ where: { institutionId } });
    await prisma.payrollRun.deleteMany({ where: { institutionId } });
    await prisma.staff.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("edits line items and recomputes gross/net pay", async () => {
    const res = await request(app)
      .patch(`/api/admin/payroll/runs/${runId}/payslips/${payslipId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ earnings: [{ label: "Basic", amount: 10000 }, { label: "Bonus", amount: 2000 }], deductions: [{ label: "Advance", amount: 500 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.grossPay).toBe(12000);
    expect(res.body.data.netPay).toBe(11500);
  });

  it("rejects editing once the run is published", async () => {
    await prisma.payrollRun.update({ where: { id: runId }, data: { status: "PUBLISHED" } });
    const res = await request(app)
      .patch(`/api/admin/payroll/runs/${runId}/payslips/${payslipId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ earnings: [{ label: "Basic", amount: 99999 }], deductions: [] });
    expect(res.status).toBe(400);
    await prisma.payrollRun.update({ where: { id: runId }, data: { status: "DRAFT" } }); // reset for next test
  });

  it("removes a payslip from a draft run", async () => {
    const res = await request(app)
      .delete(`/api/admin/payroll/runs/${runId}/payslips/${payslipId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const found = await prisma.payslip.findUnique({ where: { id: payslipId } });
    expect(found).toBeNull();
  });
});
