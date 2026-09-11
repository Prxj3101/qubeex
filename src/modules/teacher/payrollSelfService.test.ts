import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { uploadAttachmentToR2, r2KeyFromUrl, deleteFromR2 } from "../../services/storage.service";

describe("Teacher self-service payslips", () => {
  const suffix = `${Date.now()}-payroll-self`;
  let institutionId: string;
  let teacherAToken: string;
  let teacherBToken: string;
  let publishedPayslipId: string;
  let draftPayslipId: string;
  let uploadedPdfUrl: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `Payroll Self Test ${suffix}`, email: `payroll-self-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `PYSF-${suffix.slice(-6)}`, userIdPrefix: "PYSF", status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const userA = await prisma.user.create({ data: { name: "Self A", email: `sa-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true } });
    const teacherA = await prisma.teacher.create({ data: { teacherId: `SA-${suffix}`, userId: userA.id, institutionId } });
    teacherAToken = jwt.sign({ userId: userA.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const userB = await prisma.user.create({ data: { name: "Self B", email: `sb-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true } });
    await prisma.teacher.create({ data: { teacherId: `SB-${suffix}`, userId: userB.id, institutionId } });
    teacherBToken = jwt.sign({ userId: userB.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const upload = await uploadAttachmentToR2(Buffer.from("%PDF-1.4 fake payslip content"), {
      originalName: "payslip.pdf",
      contentType: "application/pdf",
      institutionId,
      area: "payroll",
      skipSizeLimit: true,
    });
    uploadedPdfUrl = upload.publicUrl;

    const publishedRun = await prisma.payrollRun.create({ data: { institutionId, month: "2027-02", status: "PUBLISHED", publishedAt: new Date() } });
    const publishedPayslip = await prisma.payslip.create({
      data: { payrollRunId: publishedRun.id, teacherId: teacherA.id, institutionId, earnings: [{ label: "Basic", amount: 12000 }], deductions: [], grossPay: 12000, netPay: 12000, pdfUrl: uploadedPdfUrl },
    });
    publishedPayslipId = publishedPayslip.id;

    const draftRun = await prisma.payrollRun.create({ data: { institutionId, month: "2027-03", status: "DRAFT" } });
    const draftPayslip = await prisma.payslip.create({
      data: { payrollRunId: draftRun.id, teacherId: teacherA.id, institutionId, earnings: [{ label: "Basic", amount: 12000 }], deductions: [], grossPay: 12000, netPay: 12000 },
    });
    draftPayslipId = draftPayslip.id;
  });

  afterAll(async () => {
    if (uploadedPdfUrl) {
      const r2Key = r2KeyFromUrl(uploadedPdfUrl);
      if (r2Key) await deleteFromR2(r2Key);
    }
    await prisma.payslip.deleteMany({ where: { institutionId } });
    await prisma.payrollRun.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("lists only this teacher's published payslips, never draft ones", async () => {
    const res = await request(app)
      .get("/api/teacher/payroll/payslips")
      .set("Authorization", `Bearer ${teacherAToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toContain(publishedPayslipId);
    expect(ids).not.toContain(draftPayslipId);
  });

  it("returns an empty list for a teacher with no payslips", async () => {
    const res = await request(app)
      .get("/api/teacher/payroll/payslips")
      .set("Authorization", `Bearer ${teacherBToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("404s fetching another teacher's payslip PDF", async () => {
    const res = await request(app)
      .get(`/api/teacher/payroll/payslips/${publishedPayslipId}/pdf`)
      .set("Authorization", `Bearer ${teacherBToken}`);
    expect(res.status).toBe(404);
  });

  it("404s fetching a draft (unpublished) payslip's PDF even as its own teacher", async () => {
    const res = await request(app)
      .get(`/api/teacher/payroll/payslips/${draftPayslipId}/pdf`)
      .set("Authorization", `Bearer ${teacherAToken}`);
    expect(res.status).toBe(404);
  });

  it("streams back the PDF bytes for the owning teacher's published payslip", async () => {
    const res = await request(app)
      .get(`/api/teacher/payroll/payslips/${publishedPayslipId}/pdf`)
      .set("Authorization", `Bearer ${teacherAToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.body.length).toBeGreaterThan(0);
  });
});
