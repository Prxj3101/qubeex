import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError } from "../../utils/errors";

const router = Router();
router.get("/alerts", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = req.user?.institutionId;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const parsed = z.object({ asOf: z.iso.date().default(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })) }).strict().safeParse(req.query);
    if (!parsed.success) throw new BadRequestError("Choose a valid date for inventory alerts");
    const asOf = parsed.data.asOf, db = academicDb();
    const items = await db.inventoryItem.findMany({ where: { institutionId, type: "CONSUMABLE", lowStockLevel: { gt: 0 } }, include: { unit: true, balances: { select: { quantity: true } } }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    const lowStock = items.map(item => ({ id: item.id, name: item.name, code: item.code, quantity: item.balances.reduce((sum, b) => sum + Number(b.quantity), 0), limit: Number(item.lowStockLevel), unit: item.unit.abbreviation || item.unit.name })).filter(item => item.quantity <= item.limit);
    const issues = await db.inventoryStockMovement.findMany({ where: { institutionId, kind: "ISSUE", returnExpected: true }, include: { item: { include: { unit: true } }, location: true, returns: { select: { quantity: true } } }, orderBy: [{ recordedOn: "asc" }, { id: "asc" }] });
    const pending = issues.map(issue => ({
      id: issue.id, itemName: issue.item.name, itemCode: issue.item.code, recipient: issue.issuedToName,
      location: issue.location.name, quantity: Number(issue.quantity) - issue.returns.reduce((sum, entry) => sum + Number(entry.quantity), 0),
      unit: issue.item.unit.abbreviation || issue.item.unit.name, dueOn: issue.dueOn?.toISOString().slice(0, 10) || null,
      overdue: !!issue.dueOn && issue.dueOn.toISOString().slice(0, 10) < asOf,
    })).filter(issue => issue.quantity > 0).sort((a,b) => Number(b.overdue) - Number(a.overdue) || (a.dueOn || "9999-12-31").localeCompare(b.dueOn || "9999-12-31") || a.id.localeCompare(b.id));
    res.json({ success: true, data: { lowStock: lowStock.slice(0,5), lowStockTotal: lowStock.length, pendingReturns: pending.slice(0,5), pendingTotal: pending.length, overdueTotal: pending.filter(issue => issue.overdue).length, asOf } });
  } catch (err) { next(err); }
});
export default router;
