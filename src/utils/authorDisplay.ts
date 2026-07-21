import { prisma } from "./prisma";

type AuthorLike = { id: string; role: string };
export type DisplayInfo = { prefix: string | null; title: string | null; avatarUrl: string | null };

// Teacher prefix/title/avatar live on the Teacher row; Admin prefix/title/avatar
// live on Institution.adminPrefix/adminTitle/adminAvatarUrl (one admin per
// institution, by design). Batches both lookups once per request instead of
// per-author. avatarUrl returned here is the raw (unsigned) storage path —
// callers must still run it through generateSignedAvatarUrlsBatch.
export async function resolveAuthorDisplay(
  authors: AuthorLike[],
  institutionId: string
): Promise<Map<string, DisplayInfo>> {
  const map = new Map<string, DisplayInfo>();

  const teacherIds = authors.filter((a) => a.role === "TEACHER").map((a) => a.id);
  const hasAdmin = authors.some((a) => a.role === "ADMIN");

  const [teachers, institution] = await Promise.all([
    teacherIds.length
      ? prisma.teacher.findMany({
          where: { userId: { in: teacherIds } },
          select: { userId: true, prefix: true, title: true, avatarUrl: true },
        })
      : Promise.resolve([]),
    hasAdmin
      ? prisma.institution.findUnique({
          where: { id: institutionId },
          select: { adminPrefix: true, adminTitle: true, adminAvatarUrl: true },
        })
      : Promise.resolve(null),
  ]);

  for (const t of teachers) map.set(t.userId, { prefix: t.prefix, title: t.title, avatarUrl: t.avatarUrl });
  if (institution) {
    for (const a of authors) {
      if (a.role === "ADMIN") {
        map.set(a.id, { prefix: institution.adminPrefix, title: institution.adminTitle, avatarUrl: institution.adminAvatarUrl });
      }
    }
  }

  return map;
}

export function formatDisplayName(name: string, prefix?: string | null): string {
  return prefix ? `${prefix} ${name}` : name;
}
