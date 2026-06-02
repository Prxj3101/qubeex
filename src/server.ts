import dotenv from "dotenv";
dotenv.config();

import app from "./app";
import { prisma } from "./utils/prisma";
import { startBillingCron } from "./crons/billing.cron";
import { startTrialCron } from "./crons/trial.cron";
import { startAddonCron } from "./crons/addon.cron";
import { startAuditRetentionCron } from "./crons/audit.cron";

const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log(`Server is running on port ${port}`);

  // Test DB connection on startup
  try {
    console.log("[DB] Testing connection...");
    await prisma.$queryRaw`SELECT 1`;
    console.log("✅  DB connected");
  } catch (err) {
    console.error("❌  DB connection failed:", err);
  }

  startBillingCron();
  startTrialCron();
  startAddonCron();
  startAuditRetentionCron();
});
