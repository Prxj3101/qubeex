/**
 * One-off data fix: before notification.service.ts's `adminOnly` expansion
 * existed, TRIAL/PLAN_EXPIRY/TICKET_REPLY notifications were created as a
 * institution-wide broadcast (NotificationRecipient.userId = null) — which
 * notifications.controller.ts's listNotifications matches for ANY role, so
 * teachers/students ended up seeing admin-only billing/trial notices once
 * they got notification UI. This re-scopes those existing rows to the
 * institution's ADMIN/SUB_ADMIN users only, so they disappear from
 * teacher/student views. Superadmin's own `broadcastNotification` rows are
 * deliberately excluded — its tag is free-form (superadmin-chosen at compose
 * time), so there's no reliable way to tell a genuinely institution-wide
 * broadcast apart from an admin-only one after the fact.
 *
 * Run once: npx tsx prisma/scripts/fixAdminOnlyNotificationRecipients.ts
 */
import { prisma } from "../../src/utils/prisma";

const ADMIN_ONLY_TAGS = ["TRIAL", "PLAN_EXPIRY", "TICKET_REPLY"];

async function main() {
  const staleRecipients = await prisma.notificationRecipient.findMany({
    where: { userId: null, notification: { tag: { in: ADMIN_ONLY_TAGS } } },
    select: { id: true, institutionId: true, notificationId: true },
  });

  if (staleRecipients.length === 0) {
    console.log("No stale broadcast recipients found. Nothing to do.");
    return;
  }

  console.log(`Found ${staleRecipients.length} stale broadcast recipient row(s).`);

  const institutionIds = [...new Set(staleRecipients.map((r) => r.institutionId))];
  const admins = await prisma.user.findMany({
    where: { institutionId: { in: institutionIds }, role: { in: ["ADMIN", "SUB_ADMIN"] } },
    select: { id: true, institutionId: true },
  });
  const adminsByInstitution = new Map<string, string[]>();
  for (const a of admins) {
    if (!a.institutionId) continue;
    const list = adminsByInstitution.get(a.institutionId) ?? [];
    list.push(a.id);
    adminsByInstitution.set(a.institutionId, list);
  }

  let created = 0;
  let deleted = 0;
  let skippedNoAdmin = 0;

  for (const stale of staleRecipients) {
    const adminIds = adminsByInstitution.get(stale.institutionId) ?? [];
    if (adminIds.length === 0) {
      skippedNoAdmin++;
      continue; // no admin to reassign to — leave the row as-is rather than delete history with nowhere to put it
    }

    await prisma.$transaction([
      prisma.notificationRecipient.delete({ where: { id: stale.id } }),
      prisma.notificationRecipient.createMany({
        data: adminIds.map((userId) => ({
          notificationId: stale.notificationId,
          institutionId: stale.institutionId,
          userId,
        })),
      }),
    ]);
    deleted++;
    created += adminIds.length;
  }

  console.log(`Done. Deleted ${deleted} broadcast row(s), created ${created} admin-scoped row(s), skipped ${skippedNoAdmin} (no admin found).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
