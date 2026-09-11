import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { r2KeyFromUrl, downloadFromR2 } from "../../services/storage.service";

// Self-service — scoped entirely from the JWT's userId, mirroring
// GET /teacher/ai-usage. There is no :teacherId param anywhere in this file,
// so a teacher can never address another teacher's payslips.
export const listMyPayslips = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const teacher = await academicDb().teacher.findFirst({ where: { userId, institutionId } });
    if (!teacher) throw new NotFoundError("Teacher profile not found");

    const payslips = await academicDb().payslip.findMany({
      where: { teacherId: teacher.id, institutionId, payrollRun: { status: "PUBLISHED" } },
      include: { payrollRun: { select: { month: true, publishedAt: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: payslips });
  } catch (err) {
    next(err);
  }
};

export const redirectToMyPayslipPdf = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const teacher = await academicDb().teacher.findFirst({ where: { userId, institutionId } });
    if (!teacher) throw new NotFoundError("Teacher profile not found");

    const payslip = await academicDb().payslip.findFirst({
      where: { id, teacherId: teacher.id, institutionId, payrollRun: { status: "PUBLISHED" } },
    });
    if (!payslip || !payslip.pdfUrl) throw new NotFoundError("Payslip not found");

    const r2Key = r2KeyFromUrl(payslip.pdfUrl);
    if (!r2Key) throw new NotFoundError("Payslip not found");
    const buffer = await downloadFromR2(r2Key);
    res.setHeader("Content-Type", "application/pdf");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
};
