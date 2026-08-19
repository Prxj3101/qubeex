import cron from "node-cron";
import { checkDatabase, checkRedis, checkStorage, checkAI, checkEmail, recordServiceCheck } from "../services/systemHealth.service";
import { recordCronRun } from "../services/cronTracker.service";

async function runHealthMonitor(): Promise<void> {
  const [db, redisCheck, storage, ai, email] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkStorage(),
    checkAI(),
    checkEmail(),
  ]);
  await Promise.all([
    recordServiceCheck("database", db),
    recordServiceCheck("redis", redisCheck),
    recordServiceCheck("storage", storage),
    recordServiceCheck("ai", ai),
    recordServiceCheck("email", email),
  ]);
}

/** Periodic background probe (every 5 min) that builds the uptime/latency history
 *  shown on the superadmin System Health page — independent of anyone viewing it. */
export function startHealthMonitorCron() {
  cron.schedule("*/5 * * * *", async () => {
    try {
      await runHealthMonitor();
      await recordCronRun("health-monitor", true);
    } catch (err) {
      console.error("[Health Monitor Cron] Error:", err);
      await recordCronRun("health-monitor", false, err instanceof Error ? err.message : "Unknown error");
    }
  });
  console.log("[Health Monitor Cron] Scheduled — every 5 minutes");
}
