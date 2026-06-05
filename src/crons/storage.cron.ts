import cron from "node-cron";
import { prisma } from "../utils/prisma";
import { deleteFromR2 } from "../services/storage.service";

export async function runStorageCleanup(): Promise<void> {
  const due = await prisma.pendingFileDeletion.findMany({
    where: { scheduledAt: { lte: new Date() } },
  });

  if (due.length === 0) return;

  console.log(`[storage cron] Processing ${due.length} pending file deletion(s)`);

  for (const entry of due) {
    await deleteFromR2(entry.r2Key);
    await prisma.pendingFileDeletion.delete({ where: { id: entry.id } });
  }

  console.log(`[storage cron] Done. Deleted ${due.length} file(s) from R2.`);
}

export function startStorageCron() {
  // Runs every day at 2:00 AM
  cron.schedule("0 2 * * *", async () => {
    try {
      await runStorageCleanup();
    } catch (err) {
      console.error("[storage cron] Error:", err);
    }
  });
}
