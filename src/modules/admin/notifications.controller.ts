import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError, NotFoundError } from "../../utils/errors";

export const listNotifications = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const page  = Math.max(1, parseInt(req.query.page  as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));

    const [recipients, total, unreadCount] = await prisma.$transaction([
      prisma.notificationRecipient.findMany({
        where: { institutionId, dismissedAt: null, OR: [{ userId: null }, { userId }] },
        include: { notification: true },
        orderBy: { notification: { createdAt: "desc" } },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.notificationRecipient.count({ where: { institutionId, dismissedAt: null, OR: [{ userId: null }, { userId }] } }),
      prisma.notificationRecipient.count({ where: { institutionId, dismissedAt: null, readAt: null, OR: [{ userId: null }, { userId }] } }),
    ]);

    const notifications = recipients.map(r => ({
      recipientId: r.id,
      id: r.notification.id,
      title: r.notification.title,
      message: r.notification.message,
      tag: r.notification.tag,
      createdAt: r.notification.createdAt,
      readAt: r.readAt,
      isRead: !!r.readAt,
    }));

    res.json({
      notifications,
      unreadCount,
      total,
      page,
      limit,
      pages: total === 0 ? 0 : Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
};

export const markNotificationRead = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const recipientId = req.params.recipientId as string;

    const existing = await prisma.notificationRecipient.findFirst({
      where: { id: recipientId, institutionId, dismissedAt: null, OR: [{ userId: null }, { userId }] },
    });
    if (!existing) throw new NotFoundError("Notification not found");

    const updated = await prisma.notificationRecipient.update({
      where: { id: recipientId },
      data: { readAt: existing.readAt ?? new Date() },
      include: { notification: true },
    });

    res.json({
      success: true,
      data: {
        recipientId: updated.id,
        id: updated.notification.id,
        readAt: updated.readAt,
        isRead: true,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const dismissNotification = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const recipientId = req.params.recipientId as string;

    const existing = await prisma.notificationRecipient.findFirst({
      where: { id: recipientId, institutionId, dismissedAt: null, OR: [{ userId: null }, { userId }] },
    });
    if (!existing) throw new NotFoundError("Notification not found");

    await prisma.notificationRecipient.update({
      where: { id: recipientId },
      data: { dismissedAt: new Date(), readAt: existing.readAt ?? new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const markAllNotificationsRead = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const now = new Date();
    const result = await prisma.notificationRecipient.updateMany({
      where: { institutionId, dismissedAt: null, readAt: null, OR: [{ userId: null }, { userId }] },
      data: { readAt: now },
    });

    res.json({ success: true, data: { updated: result.count, readAt: now } });
  } catch (err) {
    next(err);
  }
};
