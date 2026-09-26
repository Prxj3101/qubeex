import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Payroll runs across staff types", () => {
  const suffix = `${Date.now()}-staff-runs`;
  let institutionId: string;
  let adminToken: string;
  let teacherStaffId: string;
  let helperStaffId: string;
  let noStructureStaffId: string;
  let inactiveStaffId: string;
  let runId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: { name: `Staff Runs Test ${suffix}`, email: `staff-runs-${suffix}@example.com`, type: "SCHOOL", institutionCode: `SRUN-${suffix.slice(-6)}`, userIdPrefix: "SRUN", status: "ACTIVE" },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({ data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true } });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
    const basic = await prisma.salaryComponent.create({ data: { institutionId, name: "Basic", type: "EARNING", calcType: "FIXED", isBasic: true, sortOrder: 0 } });
    const advance = await prisma.salaryComponent.create({ data: { institutionId, name: "Advance", type: "DEDUCTION", calcType: "FIXED", lopApplicable: false, sortOrder: 1 } });
    const joinDate = new Date("2026-01-01T00:00:00.000Z");

    const teacherUser = await prisma.user.create({ data: { name: "Run Teacher", email: `t-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true } });
    await prisma.teacher.create({ data: { teacherId: `SR-${suffix}`, userId: teacherUser.id, institutionId } });
    const teacherStaff = await prisma.staff.create({ data: { institutionId, name: "Run Teacher", email: `t-${suffix}@example.com`, staffType: "TEACHER", userId: teacherUser.id, joinedAt: joinDate } });
    teacherStaffId = teacherStaff.id;
    await prisma.staffSalaryStructure.create({ data: { staffId: teacherStaffId, institutionId, items: [{ componentId: basic.id, value: 3000000 }], effectiveFrom: joinDate } });

    const helperStaff = await prisma.staff.create({ data: { institutionId, name: "Run Helper", email: `helper-${suffix}@example.com`, staffType: "HELPER", joinedAt: joinDate } });
    helperStaffId = helperStaff.id;
    await prisma.staffSalaryStructure.create({ data: { staffId: helperStaffId, institutionId, items: [{ componentId: basic.id, value: 800000 }, { componentId: advance.id, value: 50000 }], effectiveFrom: joinDate } });

    const noStructureStaff = await prisma.staff.create({ data: { institutionId, name: "No Structure Staff", email: `ns-${suffix}@example.com`, staffType: "OTHER" } });
    noStructureStaffId = noStructureStaff.id;

    const inactiveStaff = await prisma.staff.create({ data: { institutionId, name: "Departed Staff", email: `inactive-${suffix}@example.com`, staffType: "HELPER", status: "INACTIVE" } });
    inactiveStaffId = inactiveStaff.id;
    await prisma.staffSalaryStructure.create({ data: { staffId: inactiveStaffId, institutionId, items: [{ componentId: basic.id, value: 600000 }], effectiveFrom: joinDate } });
  });

  afterAll(async () => {
    await prisma.payslip.deleteMany({ where: { institutionId } });
    await prisma.payrollRun.deleteMany({ where: { institutionId } });
    await prisma.staffSalaryStructure.deleteMany({ where: { institutionId } });
    await prisma.salaryComponent.deleteMany({ where: { institutionId } });
    await prisma.staff.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("creates a run with payslips for every staff type that has a structure, excluding staff with none", async () => {
    const res = await request(app)
      .post("/api/admin/payroll/runs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ month: "2027-04" });
    expect(res.status).toBe(201);
    runId = res.body.data.id;

    const payslips = await prisma.payslip.findMany({ where: { payrollRunId: runId } });
    expect(payslips).toHaveLength(2);
    const staffIds = payslips.map((p) => p.staffId);
    expect(staffIds).toContain(teacherStaffId);
    expect(staffIds).toContain(helperStaffId);
    expect(staffIds).not.toContain(noStructureStaffId);
    expect(staffIds).not.toContain(inactiveStaffId);

    const helperPayslip = payslips.find((p) => p.staffId === helperStaffId)!;
    expect(helperPayslip.staffName).toBe("Run Helper");
    expect(helperPayslip.grossPay).toBe(800000);
    expect(helperPayslip.netPay).toBe(750000);
    expect(helperPayslip.paidDays).toBe(30);
  });

  it("getPayrollRun returns staffName/staffType/staffDesignation for every payslip", async () => {
    const res = await request(app).get(`/api/admin/payroll/runs/${runId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const helperEntry = res.body.data.payslips.find((p: { staffId: string }) => p.staffId === helperStaffId);
    expect(helperEntry.staffName).toBe("Run Helper");
    expect(helperEntry.staffType).toBe("HELPER");
  });
});
