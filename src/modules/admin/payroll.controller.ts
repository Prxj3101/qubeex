import { Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, NotFoundError, ConflictError } from "../../utils/errors";
import { resolveUsers } from "../../services/userLookup.service";
import { prisma } from "../../utils/prisma";
import { uploadAttachmentToR2 } from "../../services/storage.service";
import { generatePayslipPdf } from "../../services/payslipPdf.service";

const lineItemSchema = z.object({
  label: z.string().min(1).max(100),
  amount: z.number().min(0),
});

const saveSalaryTemplateSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  earnings: z.array(lineItemSchema),
  deductions: z.array(lineItemSchema),
});

export const listSalaryTemplates = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const templates = await academicDb().salaryTemplate.findMany({
      where: { institutionId },
      orderBy: { name: "asc" },
    });
    res.json({ success: true, data: templates });
  } catch (err) {
    next(err);
  }
};

export const createSalaryTemplate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const data = saveSalaryTemplateSchema.parse(req.body);

    const existing = await academicDb().salaryTemplate.findFirst({ where: { institutionId, name: data.name } });
    if (existing) throw new ConflictError(`A template named "${data.name}" already exists`);

    const template = await academicDb().salaryTemplate.create({
      data: { institutionId, name: data.name, earnings: data.earnings, deductions: data.deductions },
    });
    res.status(201).json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
};

export const updateSalaryTemplate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;
    const data = saveSalaryTemplateSchema.parse(req.body);

    const existing = await academicDb().salaryTemplate.findFirst({ where: { id, institutionId } });
    if (!existing) throw new NotFoundError("Salary template not found");

    const updated = await academicDb().salaryTemplate.update({
      where: { id },
      data: { name: data.name, earnings: data.earnings, deductions: data.deductions },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

export const deleteSalaryTemplate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const existing = await academicDb().salaryTemplate.findFirst({ where: { id, institutionId } });
    if (!existing) throw new NotFoundError("Salary template not found");

    await academicDb().salaryTemplate.delete({ where: { id } });
    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
};

const bankDetailsSchema = z.object({
  accountName: z.string(),
  accountNumber: z.string(),
  ifsc: z.string(),
  bankName: z.string(),
});

const saveTeacherSalaryStructureSchema = z.object({
  templateId: z.string().nullable().optional(),
  earnings: z.array(lineItemSchema),
  deductions: z.array(lineItemSchema),
  bankDetails: bankDetailsSchema.optional(),
  effectiveFrom: z.string().datetime(),
});

export const getTeacherSalaryStructure = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const teacherId = req.params.teacherId as string;

    const teacher = await academicDb().teacher.findFirst({ where: { id: teacherId, institutionId } });
    if (!teacher) throw new NotFoundError("Teacher not found");

    const structure = await academicDb().teacherSalaryStructure.findFirst({ where: { teacherId, institutionId } });
    res.json({ success: true, data: structure });
  } catch (err) {
    next(err);
  }
};

export const saveTeacherSalaryStructure = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const teacherId = req.params.teacherId as string;
    const data = saveTeacherSalaryStructureSchema.parse(req.body);

    const teacher = await academicDb().teacher.findFirst({ where: { id: teacherId, institutionId } });
    if (!teacher) throw new NotFoundError("Teacher not found");

    const existing = await academicDb().teacherSalaryStructure.findFirst({ where: { teacherId, institutionId } });
    const payload = {
      templateId: data.templateId ?? null,
      earnings: data.earnings,
      deductions: data.deductions,
      bankDetails: data.bankDetails ?? undefined,
      effectiveFrom: new Date(data.effectiveFrom),
    };

    const structure = existing
      ? await academicDb().teacherSalaryStructure.update({ where: { id: existing.id }, data: payload })
      : await academicDb().teacherSalaryStructure.create({ data: { teacherId, institutionId, ...payload } });

    res.json({ success: true, data: structure });
  } catch (err) {
    next(err);
  }
};

const monthSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM"),
});

type LineItem = { label: string; amount: number };
type PayslipPdfBankDetails = { accountName: string; accountNumber: string; ifsc: string; bankName: string };

function sumLineItems(items: LineItem[]): number {
  return items.reduce((sum, i) => sum + i.amount, 0);
}

export const listPayrollRuns = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const runs = await academicDb().payrollRun.findMany({
      where: { institutionId },
      orderBy: { month: "desc" },
    });
    res.json({ success: true, data: runs });
  } catch (err) {
    next(err);
  }
};

export const createPayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const { month } = monthSchema.parse(req.body);

    const existing = await academicDb().payrollRun.findFirst({ where: { institutionId, month } });
    if (existing) throw new ConflictError(`A payroll run for ${month} already exists`);

    const structures = await academicDb().teacherSalaryStructure.findMany({ where: { institutionId } });

    const run = await academicDb().$transaction(async (tx) => {
      const createdRun = await tx.payrollRun.create({ data: { institutionId, month, status: "DRAFT" } });

      for (const s of structures) {
        const earnings = s.earnings as unknown as LineItem[];
        const deductions = s.deductions as unknown as LineItem[];
        const grossPay = sumLineItems(earnings);
        const netPay = grossPay - sumLineItems(deductions);
        await tx.payslip.create({
          data: {
            payrollRunId: createdRun.id, teacherId: s.teacherId, institutionId,
            earnings, deductions, grossPay, netPay,
          },
        });
      }

      return createdRun;
    });

    res.status(201).json({ success: true, data: run });
  } catch (err) {
    next(err);
  }
};

export const getPayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const run = await academicDb().payrollRun.findFirst({ where: { id, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");

    const payslips = await academicDb().payslip.findMany({ where: { payrollRunId: id }, orderBy: { createdAt: "asc" } });
    const teachers = await academicDb().teacher.findMany({
      where: { id: { in: payslips.map((p) => p.teacherId) } },
      select: { id: true, userId: true },
    });
    const teacherUsers = await resolveUsers(teachers.map((t) => t.userId), { id: true, name: true });
    const nameByTeacherId = new Map(teachers.map((t) => [t.id, teacherUsers.get(t.userId)?.name ?? "Unknown"]));

    res.json({
      success: true,
      data: {
        ...run,
        payslips: payslips.map((p) => ({ ...p, teacherName: nameByTeacherId.get(p.teacherId) ?? "Unknown" })),
      },
    });
  } catch (err) {
    next(err);
  }
};

const editPayslipSchema = z.object({
  earnings: z.array(lineItemSchema),
  deductions: z.array(lineItemSchema),
});

export const updatePayslipLineItems = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const runId = req.params.id as string;
    const payslipId = req.params.payslipId as string;
    const data = editPayslipSchema.parse(req.body);

    const run = await academicDb().payrollRun.findFirst({ where: { id: runId, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status === "PUBLISHED") throw new BadRequestError("Cannot edit a published payroll run");

    const payslip = await academicDb().payslip.findFirst({ where: { id: payslipId, payrollRunId: runId, institutionId } });
    if (!payslip) throw new NotFoundError("Payslip not found");

    const grossPay = sumLineItems(data.earnings);
    const netPay = grossPay - sumLineItems(data.deductions);
    const updated = await academicDb().payslip.update({
      where: { id: payslipId },
      data: { earnings: data.earnings, deductions: data.deductions, grossPay, netPay },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

export const removePayslipFromRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const runId = req.params.id as string;
    const payslipId = req.params.payslipId as string;

    const run = await academicDb().payrollRun.findFirst({ where: { id: runId, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status === "PUBLISHED") throw new BadRequestError("Cannot modify a published payroll run");

    const payslip = await academicDb().payslip.findFirst({ where: { id: payslipId, payrollRunId: runId, institutionId } });
    if (!payslip) throw new NotFoundError("Payslip not found");

    await academicDb().payslip.delete({ where: { id: payslipId } });
    res.json({ success: true, data: { id: payslipId } });
  } catch (err) {
    next(err);
  }
};

export const publishPayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId: adminUserId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const runId = req.params.id as string;

    const run = await academicDb().payrollRun.findFirst({ where: { id: runId, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status === "PUBLISHED") throw new BadRequestError("This payroll run is already published");

    const payslips = await academicDb().payslip.findMany({ where: { payrollRunId: runId } });
    const teachers = await academicDb().teacher.findMany({
      where: { id: { in: payslips.map((p) => p.teacherId) } },
      select: { id: true, teacherId: true, userId: true },
    });
    const teacherUsers = await resolveUsers(teachers.map((t) => t.userId), { id: true, name: true });
    // institution.name is central data, always safe via the plain `prisma`
    // client regardless of BYOD — matches the precedent in
    // teacher/overview.controller.ts.
    const institution = await prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true } });

    for (const payslip of payslips) {
      if (payslip.pdfUrl) continue;
      const teacher = teachers.find((t) => t.id === payslip.teacherId);
      if (!teacher) continue;
      const teacherName = teacherUsers.get(teacher.userId)?.name ?? "Unknown";

      const structure = await academicDb().teacherSalaryStructure.findFirst({ where: { teacherId: teacher.id, institutionId } });
      const bankDetails = structure?.bankDetails as PayslipPdfBankDetails | null | undefined;

      const pdfBuffer = await generatePayslipPdf({
        institutionName: institution?.name ?? "",
        teacherName,
        teacherDisplayId: teacher.teacherId,
        month: run.month,
        earnings: payslip.earnings as unknown as LineItem[],
        deductions: payslip.deductions as unknown as LineItem[],
        grossPay: payslip.grossPay,
        netPay: payslip.netPay,
        bankDetails: bankDetails ?? null,
      });

      const upload = await uploadAttachmentToR2(pdfBuffer, {
        originalName: `payslip-${run.month}-${teacher.teacherId}.pdf`,
        contentType: "application/pdf",
        institutionId,
        area: "payroll",
        skipSizeLimit: true,
      });

      await academicDb().payslip.update({ where: { id: payslip.id }, data: { pdfUrl: upload.publicUrl } });

      const notification = await prisma.notification.create({
        data: {
          title: "Your payslip is ready",
          message: `Your payslip for ${run.month} has been published.`,
          tag: "PAYSLIP_PUBLISHED",
          recipientType: "USER",
          deliveredTo: 1,
          sentById: adminUserId,
          recipients: { create: [{ institutionId, userId: teacher.userId }] },
        },
      });
      void notification;
    }

    const published = await academicDb().payrollRun.update({
      where: { id: runId },
      data: { status: "PUBLISHED", publishedAt: new Date(), publishedBy: adminUserId },
    });

    res.json({ success: true, data: published });
  } catch (err) {
    next(err);
  }
};

const markPaidSchema = z.object({
  paymentMethod: z.string().max(100).optional(),
  paymentRef: z.string().max(100).optional(),
});

export const markPayslipPaid = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;
    const data = markPaidSchema.parse(req.body);

    const payslip = await academicDb().payslip.findFirst({ where: { id, institutionId } });
    if (!payslip) throw new NotFoundError("Payslip not found");

    const updated = await academicDb().payslip.update({
      where: { id },
      data: { status: "PAID", paidAt: new Date(), paymentMethod: data.paymentMethod, paymentRef: data.paymentRef },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};
