import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Mark payslip as paid", () => {
  const suffix = `${Date.now()}-payroll-paid`;
  let institutionId: string;
  let adminToken: string;
  let payslipId: string;
  let secondInstitutionId: string;
  let secondPayslipId: string;

  beforeAll(async () => {
    // Create first institution
    const institution = await prisma.institution.create({
      data: {
        name: `Payroll Paid Test ${suffix}`, email: `payroll-paid-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `PYPD-${suffix.slice(-6)}`, userIdPrefix: "PYPD", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
    const staff = await prisma.staff.create({ data: { institutionId, name: "Paid Staff", email: `t-${suffix}@example.com`, staffType: "HELPER" } });
    const run = await prisma.payrollRun.create({ data: { institutionId, month: "2027-01", status: "PUBLISHED", publishedAt: new Date() } });
    const payslip = await prisma.payslip.create({
      data: { payrollRunId: run.id, staffId: staff.id, staffName: staff.name, staffEmail: staff.email, institutionId, earnings: [{ label: "Basic", amount: 15000 }], deductions: [], grossPay: 15000, netPay: 15000 },
    });
    payslipId = payslip.id;

    // Create second institution with its own payslip to test cross-institution isolation
    const secondInstitution = await prisma.institution.create({
      data: {
        name: `Payroll Paid Test 2 ${suffix}`, email: `payroll-paid-2-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `PYPD2-${suffix.slice(-6)}`, userIdPrefix: "PYPD2", status: "ACTIVE",
      },
    });
    secondInstitutionId = secondInstitution.id;
    const secondStaff = await prisma.staff.create({ data: { institutionId: secondInstitutionId, name: "Second Staff", email: `t2-${suffix}@example.com`, staffType: "HELPER" } });
    const secondRun = await prisma.payrollRun.create({ data: { institutionId: secondInstitutionId, month: "2027-01", status: "PUBLISHED", publishedAt: new Date() } });
    const secondPayslip = await prisma.payslip.create({
      data: { payrollRunId: secondRun.id, staffId: secondStaff.id, staffName: secondStaff.name, staffEmail: secondStaff.email, institutionId: secondInstitutionId, earnings: [{ label: "Basic", amount: 20000 }], deductions: [], grossPay: 20000, netPay: 20000 },
    });
    secondPayslipId = secondPayslip.id;
  });

  afterAll(async () => {
    await prisma.payslip.deleteMany({ where: { institutionId } });
    await prisma.payrollRun.deleteMany({ where: { institutionId } });
    await prisma.staff.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});

    await prisma.payslip.deleteMany({ where: { institutionId: secondInstitutionId } });
    await prisma.payrollRun.deleteMany({ where: { institutionId: secondInstitutionId } });
    await prisma.staff.deleteMany({ where: { institutionId: secondInstitutionId } });
    await prisma.user.deleteMany({ where: { institutionId: secondInstitutionId } });
    await prisma.institution.delete({ where: { id: secondInstitutionId } }).catch(() => {});

    await prisma.$disconnect();
  });

  it("marks a payslip paid with method and reference", async () => {
    const res = await request(app)
      .patch(`/api/admin/payroll/payslips/${payslipId}/mark-paid`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ paymentMethod: "Bank Transfer", paymentRef: "TXN123456" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("PAID");
    expect(res.body.data.paymentMethod).toBe("Bank Transfer");
    expect(res.body.data.paidAt).toBeTruthy();
  });

  it("404s for a payslip in another institution", async () => {
    const res = await request(app)
      .patch(`/api/admin/payroll/payslips/does-not-exist/mark-paid`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("404s when accessing a real payslip from a different institution", async () => {
    const res = await request(app)
      .patch(`/api/admin/payroll/payslips/${secondPayslipId}/mark-paid`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ paymentMethod: "Bank Transfer", paymentRef: "TXN999999" });
    expect(res.status).toBe(404);
  });
});
