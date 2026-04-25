import { prisma } from "../utils/prisma";
import { Prisma } from "../generated/prisma/client";

interface AuditOptions {
  userId?:        string;
  actorRole?:     string;
  institutionId?: string;
  details?:       string;
  ip?:            string;
  metadata?:      Prisma.InputJsonValue;
}

export async function logAudit(
  action: string,
  options: AuditOptions = {}
): Promise<void> {
  try {
    const { userId, actorRole, institutionId, details, ip, metadata } = options;
    await prisma.auditLog.create({
      data: {
        action,
        userId:        userId        ?? null,
        actorRole:     actorRole     ?? null,
        institutionId: institutionId ?? null,
        details:       details       ?? null,
        ip:            ip            ?? null,
        metadata:      metadata      ?? Prisma.JsonNull,
      },
    });
  } catch (err) {
    console.error("Audit log failed:", err);
  }
}
