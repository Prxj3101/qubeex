import { prisma } from "../utils/prisma";
import { Prisma } from "../generated/prisma/client";

type AuditCategory = "ADMIN_ACTION" | "SECURITY" | "SYSTEM" | "BILLING" | "SUPERADMIN_ACTION";
type AuditSeverity = "INFO" | "WARNING" | "CRITICAL";

interface AuditOptions {
  userId?:        string;
  actorRole?:     string;
  institutionId?: string;
  details?:       string;
  ip?:            string;
  metadata?:      Prisma.InputJsonValue;
  category?:      AuditCategory;
  severity?:      AuditSeverity;
}

export function logAudit(
  action: string,
  options: AuditOptions = {}
): void {
  const {
    userId, actorRole, institutionId, details,
    ip, metadata,
    category = "ADMIN_ACTION",
    severity = "INFO",
  } = options;

  prisma.auditLog.create({
    data: {
      action,
      category,
      severity,
      userId:        userId        ?? null,
      actorRole:     actorRole     ?? null,
      institutionId: institutionId ?? null,
      details:       details       ?? null,
      ip:            ip            ?? null,
      metadata:      metadata      ?? Prisma.JsonNull,
    },
  }).catch((err) => console.error("Audit log failed:", err));
}
