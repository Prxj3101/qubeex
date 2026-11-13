import cron from "node-cron";
import { prisma } from "../utils/prisma";
import { createNotification } from "../services/notification.service";
import { sendLibraryReminderEmail } from "../services/email.service";
import { recordCronRun } from "../services/cronTracker.service";

// Managed institutions only: BYOD tenants keep library data in their own database and no
// cron here iterates per-tenant connections yet (same scope limit as the other crons).
const DAY_MS = 864e5;
const startOfUtcDay = (d: Date) => new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

export function selectLoansToRemind<T extends { dueAt: Date; lastRemindedAt: Date | null }>(
  loans: T[],
  now: Date,
  dueSoonDays: number,
): (T & { overdue: boolean })[] {
  const horizon = now.getTime() + dueSoonDays * DAY_MS;
  const today = startOfUtcDay(now).getTime();
  return loans
    .filter((l) => l.dueAt.getTime() <= horizon && (l.lastRemindedAt === null || l.lastRemindedAt.getTime() < today))
    .map((l) => ({ ...l, overdue: l.dueAt.getTime() < now.getTime() }));
}

async function remindInstitution(institutionId: string, institutionName: string, dueSoonDays: number, now: Date) {
  const loans = await prisma.libraryLoan.findMany({
    where: { institutionId, returnedAt: null },
    include: { copy: { select: { book: { select: { title: true } } } } },
  });
  const selected = selectLoansToRemind(loans, now, dueSoonDays);
  if (selected.length === 0) return;

  const byBorrower = new Map<string, typeof selected>();
  for (const l of selected) byBorrower.set(l.borrowerUserId, [...(byBorrower.get(l.borrowerUserId) ?? []), l]);

  const users = await prisma.user.findMany({
    where: { institutionId, id: { in: [...byBorrower.keys()] } },
    select: { id: true, name: true, email: true, isActive: true },
  });

  for (const user of users.filter((u) => u.isActive)) {
    const items = (byBorrower.get(user.id) ?? []).map((l) => ({
      title: l.copy.book.title,
      dueLabel: l.overdue ? `was due ${shortDate(l.dueAt)}` : `due ${shortDate(l.dueAt)}`,
      overdue: l.overdue,
    }));
    await createNotification({
      title: "Library: books to return",
      message: items.map((i) => `${i.title} (${i.dueLabel})`).join(", "),
      tag: "LIBRARY",
      recipientType: "SYSTEM",
      recipients: [{ institutionId, userId: user.id }],
    });
    if (user.email) await sendLibraryReminderEmail({ to: user.email, name: user.name ?? "there", institutionName, items });
  }

  // Marked even for deactivated borrowers, so tomorrow's run does not re-count them.
  await prisma.libraryLoan.updateMany({
    where: { id: { in: selected.map((l) => l.id) }, institutionId },
    data: { lastRemindedAt: now },
  });

  const overdue = selected.filter((l) => l.overdue);
  if (overdue.length > 0) {
    const [admins, librarians] = await Promise.all([
      prisma.user.findMany({ where: { institutionId, role: "ADMIN" }, select: { id: true } }),
      prisma.subAdmin.findMany({ where: { institutionId, permissions: { has: "LIBRARY" } }, select: { userId: true } }),
    ]);
    const recipientIds = [...new Set([...admins.map((a) => a.id), ...librarians.map((s) => s.userId)])];
    if (recipientIds.length > 0) {
      const members = new Set(overdue.map((l) => l.borrowerUserId)).size;
      await createNotification({
        title: "Library: overdue books",
        message: `${overdue.length} book${overdue.length === 1 ? " is" : "s are"} overdue (${members} member${members === 1 ? "" : "s"}). See Library > Reports > Overdue.`,
        tag: "LIBRARY",
        recipientType: "SYSTEM",
        recipients: recipientIds.map((userId) => ({ institutionId, userId })),
      });
    }
  }
}

export async function runLibraryReminders(now: Date = new Date()): Promise<void> {
  const settings = await prisma.librarySettings.findMany({ where: { rulesConfigured: true }, select: { institutionId: true, dueSoonDays: true } });
  if (settings.length === 0) return;
  const institutions = await prisma.institution.findMany({
    where: { id: { in: settings.map((s) => s.institutionId) }, status: "ACTIVE" },
    select: { id: true, name: true },
  });
  for (const inst of institutions) {
    const dueSoonDays = settings.find((s) => s.institutionId === inst.id)?.dueSoonDays ?? 2;
    try {
      await remindInstitution(inst.id, inst.name, dueSoonDays, now);
    } catch (err) {
      console.error(`[Library Reminder Cron] ${inst.id} failed:`, err);
    }
  }
}

export function startLibraryReminderCron() {
  cron.schedule("0 8 * * *", async () => {
    console.log(`[Library Reminder Cron] Running at ${new Date().toISOString()}`);
    try {
      await runLibraryReminders();
      await recordCronRun("library-reminders", true);
    } catch (err) {
      console.error("[Library Reminder Cron] Run failed:", err);
      await recordCronRun("library-reminders", false, err instanceof Error ? err.message : "Unknown error");
    }
  }, { timezone: "Asia/Kolkata" });
  console.log("[Library Reminder Cron] Scheduled — daily 08:00 IST");
}
