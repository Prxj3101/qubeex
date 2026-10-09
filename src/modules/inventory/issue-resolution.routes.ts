import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";
const router = Router();
const idSchema = z.string().uuid();
const schema = z.object({ requestId: idSchema, issueId: idSchema, resolutionType: z.enum(["DAMAGED", "LOST"]), quantity: z.string().trim().regex(/^\d{1,10}$/, "Enter a whole-number quantity").refine(v => Number(v) >= 1 && Number(v) <= 1000000000, "Enter a quantity of at least 1"), recordedOn: z.iso.date(), reason: z.string().trim().min(1, "Enter a reason").max(500) }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new BadRequestError(result.error.issues[0]?.message || "Invalid issued-item details"); return result.data; }
const include = { movements: { select: { kind: true, locationId: true } }, category: { select: { id: true, name: true } }, unit: { select: { id: true, name: true, abbreviation: true } }, balances: { include: { location: { select: { id: true, name: true } } } } };
router.post("/items/:id/resolve-issue", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = req.user?.institutionId;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = parse(idSchema, req.params.id), input = parse(schema, req.body), kind = input.resolutionType === "DAMAGED" ? "ISSUE_DAMAGED" : "ISSUE_LOST";
    await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id, institutionId } });
      if (!item) throw new NotFoundError("Item not found");
      const issue = await tx.inventoryStockMovement.findFirst({ where: { id: input.issueId, institutionId, itemId: id, kind: "ISSUE" }, include: { returns: { select: { quantity: true } } } });
      if (!issue) throw new NotFoundError("Issue entry not found");
      if (!issue.returnExpected) throw new BadRequestError("Only items with a pending return can be closed through this flow");
      if (input.recordedOn < issue.recordedOn.toISOString().slice(0, 10)) throw new BadRequestError("Record date cannot be before the issue date");
      const existing = await tx.inventoryStockMovement.findFirst({ where: { institutionId, requestId: input.requestId } });
      if (existing) {
        if (existing.kind !== kind || existing.itemId !== id || existing.issueId !== input.issueId || !existing.quantity.equals(input.quantity) || existing.recordedOn.toISOString().slice(0,10) !== input.recordedOn || existing.notes !== input.reason) throw new ConflictError("This request was already used with different details");
        return;
      }
      const closed = issue.returns.reduce((sum,r) => sum.add(r.quantity), issue.quantity.mul(0));
      if (issue.quantity.sub(closed).lt(input.quantity)) throw new ConflictError("Quantity exceeds the pending return. Refresh the issued items list.");
      // Available stock was already deducted at issue time. Resolve custody only.
      await tx.inventoryStockMovement.create({ data: { institutionId, itemId: id, locationId: issue.locationId, kind, quantity: input.quantity, issueId: issue.id, requestId: input.requestId, issuedToType: issue.issuedToType, issuedToLabel: issue.issuedToLabel, issuedToName: issue.issuedToName, recordedOn: new Date(`${input.recordedOn}T00:00:00Z`), notes: input.reason, createdById: req.user!.userId } });
    });
    const data = await academicDb().inventoryItem.findFirst({ where: { id, institutionId }, include });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return next(new ConflictError("This request was already recorded. Refresh before retrying."));
    next(err);
  }
});
export default router;
