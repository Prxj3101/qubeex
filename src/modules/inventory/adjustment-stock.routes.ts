import { Prisma } from "../../generated/prisma/client";
import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";

const router = Router();
const idSchema = z.string().uuid();
const schema = z.object({
  requestId: idSchema, locationId: idSchema, adjustmentType: z.enum(["COUNT_CORRECTION", "DAMAGED", "LOST"]).default("COUNT_CORRECTION"),
  quantity: z.string().trim().regex(/^\d{1,10}$/, "Enter a whole-number quantity").refine(v => Number(v) <= 1000000000, "Quantity is too large"),
  expectedQuantity: z.string().trim().regex(/^\d{1,10}(\.\d{1,3})?$/).refine(v => Number(v) <= 1000000000, "Quantity is too large"),
  recordedOn: z.iso.date(), reason: z.string().trim().min(1, "Enter an adjustment reason").max(500),
}).strict().refine(v => v.adjustmentType === "COUNT_CORRECTION" || Number(v.quantity) >= 1, "Enter a damaged or lost quantity of at least 1");
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestError(result.error.issues[0]?.message || "Invalid adjustment details");
  return result.data;
}
const include = { movements: { select: { kind: true, locationId: true } }, category: { select: { id: true, name: true } }, unit: { select: { id: true, name: true, abbreviation: true } }, balances: { include: { location: { select: { id: true, name: true } } } } };

router.post("/items/:id/adjust-stock", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = req.user?.institutionId;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = parse(idSchema, req.params.id), input = parse(schema, req.body);
    const correctedQuantity = input.adjustmentType === "COUNT_CORRECTION" ? new Prisma.Decimal(input.quantity) : new Prisma.Decimal(input.expectedQuantity).sub(input.quantity);
    if (correctedQuantity.lt(0)) throw new BadRequestError("Damaged or lost quantity cannot exceed available stock");
    await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id, institutionId } });
      if (!item) throw new NotFoundError("Item not found");
      const existing = await tx.inventoryStockMovement.findFirst({ where: { institutionId, requestId: input.requestId } });
      if (existing) {
        if (existing.kind !== "ADJUSTMENT" || existing.itemId !== id || existing.locationId !== input.locationId || !existing.previousQuantity?.equals(input.expectedQuantity) || !existing.correctedQuantity?.equals(correctedQuantity) || (existing.adjustmentType || "COUNT_CORRECTION") !== input.adjustmentType || existing.recordedOn.toISOString().slice(0, 10) !== input.recordedOn || existing.notes !== input.reason) throw new ConflictError("This adjustment request was already used with different details");
        return;
      }
      const balance = await tx.inventoryStockBalance.findFirst({ where: { institutionId, itemId: id, locationId: input.locationId } });
      if (!balance) throw new NotFoundError("Stock not found for this location");
      if (!balance.quantity.equals(input.expectedQuantity)) throw new ConflictError("Stock changed since this form was opened. Refresh and try again.");
      if (balance.quantity.equals(correctedQuantity)) throw new BadRequestError("Enter a different quantity to make an adjustment");
      await tx.inventoryStockMovement.create({ data: {
        institutionId, itemId: id, locationId: input.locationId, kind: "ADJUSTMENT", requestId: input.requestId, adjustmentType: input.adjustmentType,
        quantity: balance.quantity.sub(correctedQuantity).abs(), previousQuantity: balance.quantity, correctedQuantity,
        recordedOn: new Date(`${input.recordedOn}T00:00:00Z`), notes: input.reason, createdById: req.user!.userId,
      } });
      await tx.inventoryStockBalance.update({ where: { id: balance.id }, data: { quantity: correctedQuantity } });
    });
    const data = await academicDb().inventoryItem.findFirst({ where: { id, institutionId }, include });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return next(new ConflictError("This request was already recorded. Refresh the item before retrying."));
    next(err);
  }
});
export default router;
