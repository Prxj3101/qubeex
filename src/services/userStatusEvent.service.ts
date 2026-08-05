import { prisma } from "../utils/prisma";
import type { Prisma } from "../generated/prisma/client";

type Db = typeof prisma | Prisma.TransactionClient;

/** Records a single isActive transition for a user — call this at every
 * place a user's isActive flag changes (creation, invite accepted, manual
 * activate/deactivate) so monthly active/inactive history can be
 * reconstructed later without guessing from AuditLog metadata. */
export async function recordUserStatusEvent(
  db: Db,
  params: { userId: string; institutionId: string | null; isActive: boolean }
): Promise<void> {
  await db.userStatusEvent.create({
    data: {
      userId: params.userId,
      institutionId: params.institutionId,
      isActive: params.isActive,
    },
  });
}
