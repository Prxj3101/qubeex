import { Router, Response, NextFunction } from "express";
import type { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { ConflictError } from "../../utils/errors";
import { settingsSchema } from "./library.schema";
import { institutionOf, auditLibrary } from "./library.common";
import type { BorrowerType, RuleSet } from "./library.rules";
import { BORROWER_TYPES } from "./library.schema";

type RuleRow = RuleSet & { borrowerType: string };
const toRuleSet = (r: RuleRow): RuleSet => ({
  maxBooks: r.maxBooks, loanDays: r.loanDays, maxRenewals: r.maxRenewals,
  finePerDayPaise: r.finePerDayPaise, graceDays: r.graceDays, fineCapPaise: r.fineCapPaise,
});

export async function loadActiveRules(institutionId: string) {
  const settings = await academicDb().librarySettings.findUnique({ where: { institutionId } });
  if (!settings || !settings.rulesConfigured) throw new ConflictError("Library rules are not set up yet");
  const rows = await academicDb().libraryRule.findMany({ where: { institutionId } });
  const rules = {} as Record<BorrowerType, RuleSet>;
  for (const type of BORROWER_TYPES) {
    const row = rows.find((r) => r.borrowerType === type);
    if (!row) throw new ConflictError("Library rules are not set up yet");
    rules[type] = toRuleSet(row);
  }
  return { settings, rules };
}

async function readSettings(institutionId: string) {
  const settings = await academicDb().librarySettings.findUnique({ where: { institutionId } });
  const rows = await academicDb().libraryRule.findMany({ where: { institutionId } });
  const rules = {} as Record<BorrowerType, RuleSet | null>;
  for (const type of BORROWER_TYPES) {
    const row = rows.find((r) => r.borrowerType === type);
    rules[type] = row ? toRuleSet(row) : null;
  }
  return {
    finesMode: settings?.finesMode ?? "OFF",
    dueSoonDays: settings?.dueSoonDays ?? 2,
    lostChargePaise: settings?.lostChargePaise ?? 0,
    damagedChargePaise: settings?.damagedChargePaise ?? 0,
    rulesConfigured: settings?.rulesConfigured ?? false,
    rules,
  };
}

export const settingsRouter = Router();

settingsRouter.get("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await readSettings(institutionOf(req)) });
  } catch (err) { next(err); }
});

settingsRouter.put("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const input = settingsSchema.parse(req.body);
    await academicDb().$transaction(async (tx) => {
      const fields = {
        finesMode: input.finesMode, dueSoonDays: input.dueSoonDays,
        lostChargePaise: input.lostChargePaise, damagedChargePaise: input.damagedChargePaise,
        rulesConfigured: true,
      };
      await tx.librarySettings.upsert({ where: { institutionId }, create: { institutionId, ...fields }, update: fields });
      for (const borrowerType of BORROWER_TYPES) {
        const rule = input.rules[borrowerType];
        await tx.libraryRule.upsert({
          where: { institutionId_borrowerType: { institutionId, borrowerType } },
          create: { institutionId, borrowerType, ...rule },
          update: rule,
        });
      }
    });
    auditLibrary(req, "LIBRARY_SETTINGS_UPDATED", "Library settings updated", { finesMode: input.finesMode });
    res.json({ success: true, data: await readSettings(institutionId) });
  } catch (err) { next(err); }
});
