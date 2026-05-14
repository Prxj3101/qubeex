import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError } from "../../utils/errors";

export const listNotifications = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

    const [recipients, total] = await prisma.$transaction([
      prisma.notificationRecipient.findMany({
        where: { institutionId },
        include: { notification: true },
        orderBy: { notification: { createdAt: "desc" } },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.notificationRecipient.count({ where: { institutionId } }),
    ]);

    const notifications = recipients.map(r => ({
      id: r.notification.id,
      title: r.notification.title,
      message: r.notification.message,
      tag: r.notification.tag,
      createdAt: r.notification.createdAt,
    }));

    res.json({
      notifications,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    next(err);
  }
};
