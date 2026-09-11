import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Payroll Run creation + listing", () => {
  const suffix = `${Date.now()}-payroll-run`;
  let institutionId: string;
  let adminToken: string;
  let teacherAId: string;
  let teacherBId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `Payroll Run Test ${suffix}`, email: `payroll-run-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `PYRN-${suffix.slice(-6)}`, userIdPrefix: "PYRN", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const userA = await prisma.user.create({ data: { name: "Teacher A", email: `ta-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true } });
    const teacherA = await prisma.teacher.create({ data: { teacherId: `TA-${suffix}`, userId: userA.id, institutionId } });
    teacherAId = teacherA.id;
    await prisma.teacherSalaryStructure.create({
      data: { teacherId: teacherAId, institutionId, earnings: [{ label: "Basic", amount: 30000 }, { label: "HRA", amount: 5000 }], deductions: [{ label: "PF", amount: 1000 }], effectiveFrom: new Date("2026-01-01") },
    });

    // Teacher B has no salary structure — must be silently skipped, not error.
    const userB = await prisma.user.create({ data: { name: "Teacher B", email: `tb-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true } });
    const teacherB = await prisma.teacher.create({ data: { teacherId: `TB-${suffix}`, userId: userB.id, institutionId } });
    teacherBId = teacherB.id;
  });

  afterAll(async () => {
    await prisma.payslip.deleteMany({ where: { institutionId } });
    await prisma.payrollRun.deleteMany({ where: { institutionId } });
    await prisma.teacherSalaryStructure.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  let runId: string;

  it("creates a draft run with one payslip per teacher who has a salary structure", async () => {
    const res = await request(app)
      .post("/api/admin/payroll/runs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ month: "2026-10" });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("DRAFT");
    expect(res.body.data.month).toBe("2026-10");
    runId = res.body.data.id;

    const payslips = await prisma.payslip.findMany({ where: { payrollRunId: runId } });
    expect(payslips).toHaveLength(1); // only teacherA has a structure
    expect(payslips[0].teacherId).toBe(teacherAId);
    expect(payslips[0].grossPay).toBe(35000); // 30000 + 5000
    expect(payslips[0].netPay).toBe(34000); // 35000 - 1000
  });

  it("rejects creating a second run for the same month", async () => {
    const res = await request(app)
      .post("/api/admin/payroll/runs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ month: "2026-10" });
    expect(res.status).toBe(409);
  });

  it("lists runs most-recent-first", async () => {
    const res = await request(app)
      .get("/api/admin/payroll/runs")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { id: string }) => r.id)).toContain(runId);
  });

  it("gets run detail with payslips and teacher names", async () => {
    const res = await request(app)
      .get(`/api/admin/payroll/runs/${runId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.payslips).toHaveLength(1);
    expect(res.body.data.payslips[0].teacherName).toBe("Teacher A");
  });
});
