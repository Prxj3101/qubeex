import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { ensurePaymentLink } from "../../services/razorpay.service";

export const listBills = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = req.user!.institutionId;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));

    const [bills, total] = await Promise.all([
      prisma.bill.findMany({
        where: { institutionId },
        orderBy: { generatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          type: true,
          billingMonth: true,
          totalAmount: true,
          status: true,
          dueDate: true,
          paidAt: true,
          generatedAt: true,
          razorpayLinkUrl: true,
          paymentMethod: true,
        },
      }),
      prisma.bill.count({ where: { institutionId } }),
    ]);

    res.json({
      success: true,
      data: { bills, total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

export const getPlanHistory = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = req.user!.institutionId;

    const logs = await prisma.auditLog.findMany({
      where: { institutionId, action: "PLAN_UPGRADED" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, details: true, createdAt: true },
    });

    res.json({
      success: true,
      data: logs.map((log) => ({ id: log.id, details: log.details, date: log.createdAt })),
    });
  } catch (err) {
    next(err);
  }
};

export const getPaymentLink = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = req.user!.institutionId;
    const { id } = req.params as { id: string };

    const bill = await prisma.bill.findFirst({
      where: { id, institutionId },
      select: { id: true, status: true },
    });

    if (!bill) {
      res.status(404).json({ success: false, error: "Bill not found" });
      return;
    }

    if (bill.status === "PAID") {
      res.status(400).json({ success: false, error: "Bill is already paid" });
      return;
    }

    const { linkUrl } = await ensurePaymentLink(bill.id);

    res.json({ success: true, data: { url: linkUrl } });
  } catch (err) {
    next(err);
  }
};
