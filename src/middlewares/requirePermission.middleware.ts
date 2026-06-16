import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth.middleware";
import { ForbiddenError } from "../utils/errors";

/**
 * For ADMIN/SUPER_ADMIN: always passes through.
 * For SUB_ADMIN: requires at least one of the given permission keys.
 * For any other role: rejects.
 */
export function requirePermission(...permissions: string[]) {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    const user = req.user!;
    if (user.role === "SUPER_ADMIN" || user.role === "ADMIN") return next();
    if (user.role === "SUB_ADMIN") {
      const hasAny = permissions.some((p) => user.permissions?.includes(p));
      if (hasAny) return next();
    }
    throw new ForbiddenError("Insufficient permissions");
  };
}
