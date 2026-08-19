import dotenv from "dotenv";
dotenv.config();

import app, { connectionStatus } from "./app";
import { prisma } from "./utils/prisma";
import { redis } from "./utils/redis";
import { startBillingCron } from "./crons/billing.cron";
import { startTrialCron } from "./crons/trial.cron";
import { startAddonCron } from "./crons/addon.cron";
import { startAuditRetentionCron } from "./crons/audit.cron";
import { startStorageCron } from "./crons/storage.cron";
import { startHealthMonitorCron } from "./crons/healthMonitor.cron";

const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log(`Server is running on port ${port}`);

  // Test DB connection
  try {
    await prisma.$queryRaw`SELECT 1`;
    connectionStatus.db = true;
    console.log("✅  DB connected");
  } catch (err) {
    console.error("❌  DB connection failed:", err);
  }

  // Test Redis connection (optional — app works without it)
  try {
    if (redis) {
      await redis.ping();
      connectionStatus.redis = true;
      console.log("✅  Redis connected");
    } else {
      console.log("⚠️  Redis not configured — using in-memory fallback");
    }
  } catch {
    console.warn("⚠️  Redis unavailable — using in-memory fallback");
  }

  startBillingCron();
  startTrialCron();
  startAddonCron();
  startAuditRetentionCron();
  startStorageCron();
  startHealthMonitorCron();
});
