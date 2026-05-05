"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const app_1 = __importDefault(require("./app"));
const billing_cron_1 = require("./crons/billing.cron");
const trial_cron_1 = require("./crons/trial.cron");
const addon_cron_1 = require("./crons/addon.cron");
const port = process.env.PORT || 3000;
app_1.default.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    (0, billing_cron_1.startBillingCron)();
    (0, trial_cron_1.startTrialCron)();
    (0, addon_cron_1.startAddonCron)();
});
