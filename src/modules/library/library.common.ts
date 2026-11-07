import type { AuthRequest } from "../../middlewares/auth.middleware";
import { BadRequestError } from "../../utils/errors";
import { logAudit } from "../../services/audit.service";
import type { Prisma } from "../../generated/prisma/client";

export const institutionOf = (req: AuthRequest): string => {
  if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account");
  return req.user.institutionId;
};

export const actorIdOf = (req: AuthRequest): string => {
  if (!req.user?.userId) throw new BadRequestError("No user associated with this request");
  return req.user.userId;
};

export const auditLibrary = (req: AuthRequest, action: string, details: string, metadata?: Prisma.InputJsonValue): void => {
  logAudit(action, {
    userId: req.user?.userId,
    actorRole: req.user?.role,
    institutionId: req.user?.institutionId,
    details,
    metadata,
    ip: req.ip,
  });
};
