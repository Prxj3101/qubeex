import { prisma } from "../utils/prisma";
import { Prisma } from "../generated/prisma/client";

export async function logAudit(
  action: string,
  userId?: string,
  metadata?: Prisma.InputJsonValue
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        userId: userId ?? null,
        metadata: metadata ?? Prisma.JsonNull,
      },
    });
  } catch (err) {
    console.error("Audit log failed:", err);
  }
}
