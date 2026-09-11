import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { r2KeyFromUrl, downloadFromR2 } from "../../services/storage.service";

// Any Admin or Sub-Admin viewing their OWN payslips (if they've been added
// as a Staff member and linked to their own account). Scoped entirely from
// the JWT's userId — no :staffId param, so nobody can address someone
// else's payslips through this route.
export const listMyPayslips = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const staff = await academicDb().staff.findFirst({ where: { userId, institutionId } });
    if (!staff) throw new NotFoundError("Staff profile not found");

    const payslips = await academicDb().payslip.findMany({
      where: { staffId: staff.id, institutionId, payrollRun: { status: "PUBLISHED" } },
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

    const staff = await academicDb().staff.findFirst({ where: { userId, institutionId } });
    if (!staff) throw new NotFoundError("Staff profile not found");

    const payslip = await academicDb().payslip.findFirst({
      where: { id, staffId: staff.id, institutionId, payrollRun: { status: "PUBLISHED" } },
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
