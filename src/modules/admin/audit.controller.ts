import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError } from "../../utils/errors";

export const listAuditLogs = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 15));

    const action    = req.query.action    as string | undefined;
    const actorRole = req.query.actorRole as string | undefined;
    const from      = req.query.from      as string | undefined;
    const to        = req.query.to        as string | undefined;

    const fromDate = from ? new Date(from) : undefined;
    const toDate   = to   ? new Date(to)   : undefined;

    if (fromDate && isNaN(fromDate.getTime())) throw new BadRequestError("Invalid 'from' date");
    if (toDate   && isNaN(toDate.getTime()))   throw new BadRequestError("Invalid 'to' date");

    const where: Record<string, unknown> = { institutionId };
    if (action    && action    !== "All Action Types") where.action    = action;
    if (actorRole && actorRole !== "All Roles")        where.actorRole = actorRole;
    if (fromDate || toDate) {
      where.createdAt = {
        ...(fromDate ? { gte: fromDate } : {}),
        ...(toDate   ? { lte: toDate   } : {}),
      };
    }

    const [logs, total] = await prisma.$transaction([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      logs,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
};
