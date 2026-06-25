import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth.middleware";
import { ForbiddenError } from "../utils/errors";
import { redis } from "../utils/redis";
import { prisma } from "../utils/prisma";

const PERM_CACHE_TTL = 300; // 5 minutes

async function getSubAdminPermissions(userId: string): Promise<string[]> {
  const cacheKey = `sub:perms:${userId}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached as string);
    } catch {
      // Redis unavailable — fall through to DB
    }
  }

  const subAdmin = await prisma.subAdmin.findFirst({
    where: { userId },
    select: { permissions: true },
  });

  const perms = subAdmin?.permissions ?? [];

  if (redis) {
    // Fire-and-forget — never let a cache write fail the request
    redis.set(cacheKey, JSON.stringify(perms), "EX", PERM_CACHE_TTL).catch(() => {});
  }

  return perms;
}

/**
 * For ADMIN/SUPER_ADMIN: always passes through.
 * For SUB_ADMIN: fetches live permissions from Redis/DB — never trusts the JWT alone.
 */
export function requirePermission(...permissions: string[]) {
  return async (req: AuthRequest, _res: Response, next: NextFunction) => {
    try {
      const user = req.user!;

      if (user.role === "SUPER_ADMIN" || user.role === "ADMIN") return next();

      if (user.role === "SUB_ADMIN") {
        const userPermissions = await getSubAdminPermissions(user.userId);
        if (permissions.some((p) => userPermissions.includes(p))) return next();
      }

      throw new ForbiddenError("Insufficient permissions");
    } catch (err) {
      next(err);
    }
  };
}

export async function cacheSubAdminPermissions(userId: string, permissions: string[]): Promise<void> {
  if (!redis) return;
  const cacheKey = `sub:perms:${userId}`;
  try {
    // DEL before SET eliminates the stale-read window — next request always gets fresh DB data
    // if the subsequent SET fails, the cache miss forces a DB lookup which is always correct
    await redis.del(cacheKey);
    await redis.set(cacheKey, JSON.stringify(permissions), "EX", PERM_CACHE_TTL);
  } catch {
    // Best-effort — never let cache errors block the permission update response
  }
}
