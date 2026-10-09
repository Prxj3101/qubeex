import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";

const router = Router();
const idSchema = z.string().uuid();
const schema = z.object({
  requestId: idSchema, supplierId: idSchema, locationId: idSchema,
  quantity: z.string().trim().regex(/^\d{1,10}$/, "Enter a whole-number quantity").refine(v => Number(v) >= 1 && Number(v) <= 1000000000, "Enter a quantity of at least 1, up to 1,000,000,000"),
  recordedOn: z.iso.date(), reason: z.string().trim().min(1, "Enter a supplier return reason").max(500),
}).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestError(result.error.issues[0]?.message || "Invalid supplier return details");
  return result.data;
}
const include = { movements: { select: { kind: true, locationId: true } }, category: { select: { id: true, name: true } }, unit: { select: { id: true, name: true, abbreviation: true } }, balances: { include: { location: { select: { id: true, name: true } } } } };

router.post("/items/:id/supplier-return", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = req.user?.institutionId;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = parse(idSchema, req.params.id), input = parse(schema, req.body);
    await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id, institutionId } });
      if (!item) throw new NotFoundError("Item not found");
      const existing = await tx.inventoryStockMovement.findFirst({ where: { institutionId, requestId: input.requestId } });
      if (existing) {
        if (existing.kind !== "SUPPLIER_RETURN" || existing.itemId !== id || existing.locationId !== input.locationId || existing.supplierId !== input.supplierId || !existing.quantity.equals(input.quantity) || existing.recordedOn.toISOString().slice(0, 10) !== input.recordedOn || existing.notes !== input.reason) throw new ConflictError("This return request was already used with different details");
        return;
      }
      const supplier = await tx.inventorySupplier.findFirst({ where: { id: input.supplierId, institutionId } });
      const location = await tx.inventoryLocation.findFirst({ where: { id: input.locationId, institutionId } });
      if (!supplier || !location) throw new BadRequestError("Select a supplier and location from your school setup");
      const balance = await tx.inventoryStockBalance.findFirst({ where: { institutionId, itemId: id, locationId: input.locationId } });
      if (!balance || balance.quantity.lt(input.quantity)) throw new ConflictError("Not enough stock at this location. Refresh and check the available quantity.");
      await tx.inventoryStockBalance.update({ where: { id: balance.id }, data: { quantity: balance.quantity.sub(input.quantity) } });
      await tx.inventoryStockMovement.create({ data: {
        institutionId, itemId: id, locationId: input.locationId, kind: "SUPPLIER_RETURN", quantity: input.quantity,
        supplierId: supplier.id, supplierName: supplier.name, requestId: input.requestId,
        recordedOn: new Date(`${input.recordedOn}T00:00:00Z`), notes: input.reason, createdById: req.user!.userId,
      } });
    });
    const data = await academicDb().inventoryItem.findFirst({ where: { id, institutionId }, include });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return next(new ConflictError("This request was already recorded. Refresh the item before retrying."));
    if ((err as { code?: string })?.code === "P2003") return next(new ConflictError("A selected supplier or location is no longer available"));
    next(err);
  }
});
export default router;
