import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { r2KeyFromUrl, deleteFromR2 } from "../../services/storage.service";

describe("Publish a payroll run", () => {
  const suffix = `${Date.now()}-payroll-pub`;
  let institutionId: string;
  let adminToken: string;
  let teacherUserId: string;
  let teacherId: string;
  let runId: string;
  let payslipId: string;
  let uploadedPdfUrl: string | undefined;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `Payroll Publish Test ${suffix}`, email: `payroll-pub-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `PYPB-${suffix.slice(-6)}`, userIdPrefix: "PYPB", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
    const teacherUser = await prisma.user.create({ data: { name: "Pub Teacher", email: `t-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true } });
    teacherUserId = teacherUser.id;
    const teacher = await prisma.teacher.create({ data: { teacherId: `PB-${suffix}`, userId: teacherUser.id, institutionId } });
    teacherId = teacher.id;

    const run = await prisma.payrollRun.create({ data: { institutionId, month: "2026-12", status: "DRAFT" } });
    runId = run.id;
    const payslip = await prisma.payslip.create({
      data: { payrollRunId: runId, teacherId, institutionId, earnings: [{ label: "Basic", amount: 20000 }], deductions: [], grossPay: 20000, netPay: 20000 },
    });
    payslipId = payslip.id;
  });

  afterAll(async () => {
    if (uploadedPdfUrl) {
      const r2Key = r2KeyFromUrl(uploadedPdfUrl);
      if (r2Key) await deleteFromR2(r2Key);
    }
    await prisma.notificationRecipient.deleteMany({ where: { userId: teacherUserId } });
    await prisma.payslip.deleteMany({ where: { institutionId } });
    await prisma.payrollRun.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("publishes the run, generates a PDF per payslip, and notifies the teacher", async () => {
    const res = await request(app)
      .post(`/api/admin/payroll/runs/${runId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("PUBLISHED");
    expect(res.body.data.publishedAt).toBeTruthy();

    const payslip = await prisma.payslip.findUnique({ where: { id: payslipId } });
    expect(payslip?.pdfUrl).toMatch(/^https?:\/\//);
    uploadedPdfUrl = payslip?.pdfUrl ?? undefined;

    const recipient = await prisma.notificationRecipient.findFirst({
      where: { userId: teacherUserId, notification: { title: { contains: "payslip" } } },
    });
    expect(recipient).not.toBeNull();
  });

  it("rejects publishing an already-published run", async () => {
    const res = await request(app)
      .post(`/api/admin/payroll/runs/${runId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});
