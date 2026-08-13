import { prisma } from "./prisma";
import { academicDb } from "./academicContext";

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
  const subAdminIds = authors.filter((a) => a.role === "SUB_ADMIN").map((a) => a.id);
  const hasAdmin = authors.some((a) => a.role === "ADMIN");

  const [teachers, subAdmins, institution] = await Promise.all([
    teacherIds.length
      ? academicDb().teacher.findMany({
          where: { userId: { in: teacherIds } },
          select: { userId: true, prefix: true, title: true, avatarUrl: true },
        })
      : Promise.resolve([]),
    // Sub-admins don't have a fixed "title" field — their designation (e.g.
    // "Fee Collector") plays the same role Teacher.title does, so it's what
    // gets shown next to their name everywhere (feed, class workspace, etc.).
    subAdminIds.length
      ? prisma.subAdmin.findMany({
          where: { userId: { in: subAdminIds } },
          select: { userId: true, prefix: true, designation: true, avatarUrl: true },
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
  for (const s of subAdmins) map.set(s.userId, { prefix: s.prefix, title: s.designation, avatarUrl: s.avatarUrl });
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
