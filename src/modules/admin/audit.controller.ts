import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError } from "../../utils/errors";
import { resolveAuthorDisplay } from "../../utils/authorDisplay";

const VALID_CATEGORIES = ["ADMIN_ACTION", "SECURITY", "SYSTEM", "BILLING", "SUPERADMIN_ACTION"] as const;
type AuditCategory = typeof VALID_CATEGORIES[number];

// Admin can see ADMIN_ACTION (default) and SECURITY.
// SYSTEM, BILLING, SUPERADMIN_ACTION are superadmin-only.
const ADMIN_ALLOWED_CATEGORIES: AuditCategory[] = ["ADMIN_ACTION", "SECURITY"];

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
    const search    = req.query.search    as string | undefined;

    // Category filter — default ADMIN_ACTION, admin can only access ADMIN_ACTION | SECURITY
    const rawCategory = (req.query.category as string) ?? "ADMIN_ACTION";
    if (!VALID_CATEGORIES.includes(rawCategory as AuditCategory)) {
      throw new BadRequestError("Invalid category");
    }
    const category = rawCategory as AuditCategory;
    if (!ADMIN_ALLOWED_CATEGORIES.includes(category)) {
      throw new BadRequestError("Access denied for this log category");
    }

    const fromDate = from ? new Date(from) : undefined;
    const toDate   = to   ? new Date(to)   : undefined;

    if (fromDate && isNaN(fromDate.getTime())) throw new BadRequestError("Invalid 'from' date");
    if (toDate   && isNaN(toDate.getTime()))   throw new BadRequestError("Invalid 'to' date");

    const where: Record<string, unknown> = { institutionId, category };

    if (action    && action    !== "All Action Types") where.action    = action;
    if (actorRole && actorRole !== "All Roles")        where.actorRole = actorRole;
    if (fromDate || toDate) {
      where.createdAt = {
        ...(fromDate ? { gte: fromDate } : {}),
        ...(toDate   ? { lte: toDate   } : {}),
      };
    }
    if (search?.trim()) {
      const q = search.trim();
      where.OR = [
        { details:  { contains: q, mode: "insensitive" } },
        { action:   { contains: q, mode: "insensitive" } },
        { user: { is: { name:  { contains: q, mode: "insensitive" } } } },
        { user: { is: { email: { contains: q, mode: "insensitive" } } } },
      ];
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

    const displayMap = await resolveAuthorDisplay(
      logs.filter((l) => l.user && l.actorRole).map((l) => ({ id: l.user!.id, role: l.actorRole! })),
      institutionId
    );
    const logsWithPrefix = logs.map((l) => ({
      ...l,
      user: l.user ? { ...l.user, prefix: displayMap.get(l.user.id)?.prefix ?? null } : l.user,
    }));

    res.json({
      success: true,
      data: {
        logs: logsWithPrefix,
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
