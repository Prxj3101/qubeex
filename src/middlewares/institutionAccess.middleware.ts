import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth.middleware";
import { prisma } from "../utils/prisma";
import { getCache, setCache } from "../utils/cache";

// Roles allowed to operate when the institution subscription is PAUSED.
// Students lose access; admin and teachers can still manage the institution.
const PAUSED_ALLOWED_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "TEACHER"]);

// Subscription statuses that block ALL institution user access.
const BLOCKED_STATUSES = new Set(["EXPIRED", "LOCKED"]);

type CachedStatus = { subscriptionStatus: string };

export const institutionAccessMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = req.user;

    if (!user || user.role === "SUPER_ADMIN") return next();
    if (!user.institutionId) return next();

    const cacheKey = `inst:access:${user.institutionId}`;
    let cached = await getCache<CachedStatus>(cacheKey);

    if (!cached) {
      const sub = await prisma.subscription.findUnique({
        where: { institutionId: user.institutionId },
        select: { status: true },
      });
      cached = { subscriptionStatus: sub?.status ?? "ACTIVE" };
      // Short TTL — status changes need to propagate quickly
      await setCache(cacheKey, cached, 30);
    }

    const { subscriptionStatus } = cached;

    if (BLOCKED_STATUSES.has(subscriptionStatus)) {
      res.status(403).json({
        success: false,
        code: "INSTITUTION_SUSPENDED",
        message: "Your institution's access has been suspended. Please contact support.",
      });
      return;
    }

    if (subscriptionStatus === "PAUSED" && !PAUSED_ALLOWED_ROLES.has(user.role)) {
      res.status(403).json({
        success: false,
        code: "INSTITUTION_PAUSED",
        message: "Your institution is currently paused. Student access is restricted during this period.",
      });
      return;
    }

    next();
  } catch {
    // Fail open — a cache/DB error here must not block legitimate users
    next();
  }
};
