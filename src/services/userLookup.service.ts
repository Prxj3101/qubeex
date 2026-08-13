import { prisma } from "../utils/prisma";
import type { Prisma } from "../generated/prisma/client";

/**
 * Central-user batch lookup for cross-database stitching.
 *
 * Academic rows (Teacher, Student, StaffPost, …) can live in an institution's
 * own database (BYOD), while `User` is always central. A tenant DB has no
 * `User` table, so academic queries cannot `include`/`select` the `user`
 * relation — the join has to happen in application code:
 *
 *   1. Query academic rows selecting the `userId` scalar (no `user` include).
 *   2. Call `resolveUsers(userIds, select)` to fetch those users from central.
 *   3. Merge in code via the returned `Map<userId, user>`.
 *
 * For managed institutions this is one extra cheap `IN` query — correctness is
 * unchanged. `userId`s may repeat or be null/undefined; both are handled. The
 * `select` must include `id: true` so results can be keyed by user id.
 */
// Mirrors `include: { user: { omit: { password: true } } }` — every scalar
// field except the password hash. Use with resolveUsers for admin/superadmin
// views that previously relied on that shape.
export const USER_SELECT_NO_PASSWORD = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  displayId: true,
  institutionId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect & { id: true };

export async function resolveUsers<S extends Prisma.UserSelect & { id: true }>(
  userIds: ReadonlyArray<string | null | undefined>,
  select: S
): Promise<Map<string, Prisma.UserGetPayload<{ select: S }>>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  const map = new Map<string, Prisma.UserGetPayload<{ select: S }>>();
  if (ids.length === 0) return map;

  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select });
  // `select` includes `id: true` (enforced by the type bound), so id is present.
  for (const u of users) map.set((u as { id: string }).id, u);
  return map;
}
