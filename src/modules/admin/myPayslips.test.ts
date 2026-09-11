import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Admin/Sub-Admin self-service payslips", () => {
  const suffix = `${Date.now()}-my-payslips`;
  let institutionId: string;
  let subAdminToken: string;
  let subAdminUserId: string;
  let publishedPayslipId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: { name: `My Payslips Test ${suffix}`, email: `my-payslips-${suffix}@example.com`, type: "SCHOOL", institutionCode: `MYPS-${suffix.slice(-6)}`, userIdPrefix: "MYPS", status: "ACTIVE" },
    });
    institutionId = institution.id;
    const subAdminUser = await prisma.user.create({ data: { name: "Self SubAdmin", email: `sub-${suffix}@example.com`, role: "SUB_ADMIN", institutionId, isActive: true } });
    subAdminUserId = subAdminUser.id;
    subAdminToken = jwt.sign({ userId: subAdminUser.id, role: "SUB_ADMIN", institutionId }, process.env.JWT_SECRET!);
    await prisma.subAdmin.create({ data: { userId: subAdminUser.id, institutionId, permissions: [], createdById: subAdminUser.id } });
    const staff = await prisma.staff.create({ data: { institutionId, name: "Self SubAdmin", email: `sub-${suffix}@example.com`, staffType: "SUB_ADMIN", userId: subAdminUser.id } });

    const run = await prisma.payrollRun.create({ data: { institutionId, month: "2027-05", status: "PUBLISHED", publishedAt: new Date() } });
    const payslip = await prisma.payslip.create({
      data: { payrollRunId: run.id, staffId: staff.id, institutionId, staffName: "Self SubAdmin", staffEmail: `sub-${suffix}@example.com`, earnings: [{ label: "Salary", amount: 25000 }], deductions: [], grossPay: 25000, netPay: 25000 },
    });
    publishedPayslipId = payslip.id;
  });

  afterAll(async () => {
    await prisma.payslip.deleteMany({ where: { institutionId } });
    await prisma.payrollRun.deleteMany({ where: { institutionId } });
    await prisma.staff.deleteMany({ where: { institutionId } });
    await prisma.subAdmin.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("a Sub-Admin sees their own payslip via my-payslips", async () => {
    const res = await request(app).get("/api/admin/payroll/my-payslips").set("Authorization", `Bearer ${subAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: string }) => p.id)).toContain(publishedPayslipId);
  });
});
