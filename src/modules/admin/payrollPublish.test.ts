import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { r2KeyFromUrl, deleteFromR2 } from "../../services/storage.service";
import * as emailService from "../../services/email.service";

describe("Publish a payroll run", () => {
  const suffix = `${Date.now()}-payroll-pub`;
  let institutionId: string;
  let adminToken: string;
  let teacherUserId: string;
  let teacherStaffId: string;
  let helperStaffId: string;
  let runId: string;
  let teacherPayslipId: string;
  let helperPayslipId: string;
  let uploadedPdfUrls: string[] = [];
  let sendPayslipEmailSpy: jest.SpyInstance;

  beforeAll(async () => {
    sendPayslipEmailSpy = jest.spyOn(emailService, "sendPayslipEmail").mockResolvedValue(undefined);

    const institution = await prisma.institution.create({
      data: { name: `Payroll Publish Test ${suffix}`, email: `payroll-pub-${suffix}@example.com`, type: "SCHOOL", institutionCode: `PYPB-${suffix.slice(-6)}`, userIdPrefix: "PYPB", status: "ACTIVE" },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({ data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true } });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const teacherUser = await prisma.user.create({ data: { name: "Pub Teacher", email: `t-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true } });
    teacherUserId = teacherUser.id;
    await prisma.teacher.create({ data: { teacherId: `PB-${suffix}`, userId: teacherUser.id, institutionId } });
    const teacherStaff = await prisma.staff.create({ data: { institutionId, name: "Pub Teacher", email: `t-${suffix}@example.com`, staffType: "TEACHER", userId: teacherUser.id } });
    teacherStaffId = teacherStaff.id;

    const helperStaff = await prisma.staff.create({ data: { institutionId, name: "Pub Helper", email: `helper-${suffix}@example.com`, staffType: "HELPER" } });
    helperStaffId = helperStaff.id;

    const run = await prisma.payrollRun.create({ data: { institutionId, month: "2026-12", status: "DRAFT" } });
    runId = run.id;
    const teacherPayslip = await prisma.payslip.create({
      data: { payrollRunId: runId, staffId: teacherStaffId, institutionId, staffName: "Pub Teacher", staffEmail: `t-${suffix}@example.com`, earnings: [{ label: "Basic", amount: 20000 }], deductions: [], grossPay: 20000, netPay: 20000 },
    });
    teacherPayslipId = teacherPayslip.id;
    const helperPayslip = await prisma.payslip.create({
      data: { payrollRunId: runId, staffId: helperStaffId, institutionId, staffName: "Pub Helper", staffEmail: `helper-${suffix}@example.com`, earnings: [{ label: "Wage", amount: 9000 }], deductions: [], grossPay: 9000, netPay: 9000 },
    });
    helperPayslipId = helperPayslip.id;
  });

  afterAll(async () => {
    sendPayslipEmailSpy.mockRestore();
    for (const url of uploadedPdfUrls) {
      const r2Key = r2KeyFromUrl(url);
      if (r2Key) await deleteFromR2(r2Key);
    }
    await prisma.notificationRecipient.deleteMany({ where: { userId: teacherUserId } });
    await prisma.payslip.deleteMany({ where: { institutionId } });
    await prisma.payrollRun.deleteMany({ where: { institutionId } });
    await prisma.staff.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("publishes the run, generates a PDF per payslip, notifies+emails the profile-linked staff, and emails-only the payroll-only staff", async () => {
    const res = await request(app)
      .post(`/api/admin/payroll/runs/${runId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("PUBLISHED");

    const teacherPayslip = await prisma.payslip.findUnique({ where: { id: teacherPayslipId } });
    const helperPayslip = await prisma.payslip.findUnique({ where: { id: helperPayslipId } });
    expect(teacherPayslip?.pdfUrl).toMatch(/^https?:\/\//);
    expect(helperPayslip?.pdfUrl).toMatch(/^https?:\/\//);
    uploadedPdfUrls = [teacherPayslip!.pdfUrl!, helperPayslip!.pdfUrl!];

    const recipient = await prisma.notificationRecipient.findFirst({
      where: { userId: teacherUserId, notification: { title: { contains: "payslip" } } },
    });
    expect(recipient).not.toBeNull();

    expect(sendPayslipEmailSpy).toHaveBeenCalledTimes(2);
    const emailedAddresses = sendPayslipEmailSpy.mock.calls.map((c) => c[0].to);
    expect(emailedAddresses).toContain(`t-${suffix}@example.com`);
    expect(emailedAddresses).toContain(`helper-${suffix}@example.com`);
  });

  it("keeps pdfUrl null when delivery fails after upload, so a retry reprocesses that payslip", async () => {
    const run2 = await prisma.payrollRun.create({ data: { institutionId, month: "2027-01", status: "DRAFT" } });
    const teacherStaff2 = await prisma.staff.create({ data: { institutionId, name: "Retry Teacher", email: `rt-${suffix}@example.com`, staffType: "TEACHER" } });
    const helperStaff2 = await prisma.staff.create({ data: { institutionId, name: "Retry Helper", email: `rh-${suffix}@example.com`, staffType: "HELPER" } });
    const teacherPayslip2 = await prisma.payslip.create({
      data: { payrollRunId: run2.id, staffId: teacherStaff2.id, institutionId, staffName: teacherStaff2.name, staffEmail: teacherStaff2.email, earnings: [{ label: "Basic", amount: 15000 }], deductions: [], grossPay: 15000, netPay: 15000 },
    });
    const helperPayslip2 = await prisma.payslip.create({
      data: { payrollRunId: run2.id, staffId: helperStaff2.id, institutionId, staffName: helperStaff2.name, staffEmail: helperStaff2.email, earnings: [{ label: "Wage", amount: 5000 }], deductions: [], grossPay: 5000, netPay: 5000 },
    });

    sendPayslipEmailSpy.mockImplementationOnce(() => Promise.resolve(undefined));
    sendPayslipEmailSpy.mockImplementationOnce(() => Promise.reject(new Error("SMTP down")));

    const failRes = await request(app)
      .post(`/api/admin/payroll/runs/${run2.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(failRes.status).toBe(500);

    const teacherAfterFail = await prisma.payslip.findUnique({ where: { id: teacherPayslip2.id } });
    const helperAfterFail = await prisma.payslip.findUnique({ where: { id: helperPayslip2.id } });
    expect(teacherAfterFail?.pdfUrl).toMatch(/^https?:\/\//);
    expect(helperAfterFail?.pdfUrl).toBeNull();

    const runAfterFail = await prisma.payrollRun.findUnique({ where: { id: run2.id } });
    expect(runAfterFail?.status).toBe("DRAFT");

    sendPayslipEmailSpy.mockResolvedValue(undefined);

    const retryRes = await request(app)
      .post(`/api/admin/payroll/runs/${run2.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(retryRes.status).toBe(200);

    const helperAfterRetry = await prisma.payslip.findUnique({ where: { id: helperPayslip2.id } });
    expect(helperAfterRetry?.pdfUrl).toMatch(/^https?:\/\//);
    uploadedPdfUrls.push(teacherAfterFail!.pdfUrl!, helperAfterRetry!.pdfUrl!);
  });

  it("rejects publishing an already-published run", async () => {
    const res = await request(app)
      .post(`/api/admin/payroll/runs/${runId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});
