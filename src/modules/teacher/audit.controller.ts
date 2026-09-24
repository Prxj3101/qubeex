import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError } from "../../utils/errors";

const VALID_CATEGORIES = ["ADMIN_ACTION", "SECURITY"] as const;
type AuditCategory = typeof VALID_CATEGORIES[number];

// A teacher only ever sees their own activity — unlike admin's audit log
// (institution-wide), this is scoped to userId = the logged-in teacher, so
// there's no actor/role filter to offer (every row is already "them").
export const listMyAuditLogs = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 15));

    const action = req.query.action as string | undefined;
    const from   = req.query.from   as string | undefined;
    const to     = req.query.to     as string | undefined;
    const search = req.query.search as string | undefined;

    const rawCategory = (req.query.category as string) ?? "ADMIN_ACTION";
    if (!VALID_CATEGORIES.includes(rawCategory as AuditCategory)) {
      throw new BadRequestError("Invalid category");
    }
    const category = rawCategory as AuditCategory;

    const fromDate = from ? new Date(from) : undefined;
    const toDate   = to   ? new Date(to)   : undefined;

    if (fromDate && isNaN(fromDate.getTime())) throw new BadRequestError("Invalid 'from' date");
    if (toDate   && isNaN(toDate.getTime()))   throw new BadRequestError("Invalid 'to' date");

    const where: Record<string, unknown> = { institutionId, category, userId };

    if (action && action !== "All Action Types") where.action = action;
    if (fromDate || toDate) {
      where.createdAt = {
        ...(fromDate ? { gte: fromDate } : {}),
        ...(toDate   ? { lte: toDate   } : {}),
      };
    }
    if (search?.trim()) {
      const q = search.trim();
      where.OR = [
        { details: { contains: q, mode: "insensitive" } },
        { action:  { contains: q, mode: "insensitive" } },
      ];
    }

    const [logs, total] = await prisma.$transaction([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        logs,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit) || 1,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};
