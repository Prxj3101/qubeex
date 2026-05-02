import dotenv from "dotenv";
dotenv.config();

import app from "./app";
import { startBillingCron } from "./crons/billing.cron";
import { startTrialCron } from "./crons/trial.cron";

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  startBillingCron();
  startTrialCron();
});