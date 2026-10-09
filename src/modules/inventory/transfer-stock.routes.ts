import { randomUUID } from "node:crypto";
import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";

const router = Router();
const idSchema = z.string().uuid();
const schema = z.object({
  requestId: idSchema, fromLocationId: idSchema, toLocationId: idSchema,
  quantity: z.string().trim().regex(/^\d{1,10}$/, "Enter a whole-number quantity").refine(v => Number(v) > 0 && Number(v) <= 1_000_000_000, "Enter a quantity greater than zero, up to 1,000,000,000"),
  recordedOn: z.iso.date(), notes: z.string().trim().max(500).default(""),
}).strict().refine(v => v.fromLocationId !== v.toLocationId, "Select two different locations");
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestError(result.error.issues[0]?.message || "Invalid transfer details");
  return result.data;
}
const include = { movements: { select: { kind: true, locationId: true } }, category: { select: { id: true, name: true } }, unit: { select: { id: true, name: true, abbreviation: true } }, balances: { include: { location: { select: { id: true, name: true } } } } };

router.post("/items/:id/transfer-stock", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = req.user?.institutionId;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = parse(idSchema, req.params.id), input = parse(schema, req.body);
    if (!Number.isInteger(Number(input.quantity))) throw new BadRequestError("Transfer quantity must be a whole number");
    await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id, institutionId } });
      if (!item) throw new NotFoundError("Item not found");
      if (item.type !== "CONSUMABLE" && !Number.isInteger(Number(input.quantity))) throw new BadRequestError("Equipment and assets must use whole quantities");
      const existing = await tx.inventoryStockMovement.findFirst({ where: { institutionId, requestId: input.requestId } });
      if (existing) {
        if (existing.kind !== "TRANSFER_OUT" || existing.itemId !== id || existing.locationId !== input.fromLocationId || existing.transferLocationId !== input.toLocationId || !existing.quantity.equals(input.quantity) || existing.recordedOn.toISOString().slice(0, 10) !== input.recordedOn || existing.notes !== input.notes) throw new ConflictError("This transfer request was already used with different details");
        return;
      }
      const from = await tx.inventoryLocation.findFirst({ where: { id: input.fromLocationId, institutionId } });
      const to = await tx.inventoryLocation.findFirst({ where: { id: input.toLocationId, institutionId } });
      if (!from || !to) throw new BadRequestError("Select source and destination locations from your school setup");
      const source = await tx.inventoryStockBalance.findFirst({ where: { institutionId, itemId: id, locationId: from.id } });
      if (!source || source.quantity.lt(input.quantity)) throw new ConflictError("Not enough stock at the source location. Refresh and check the available quantity.");
      await tx.inventoryStockBalance.update({ where: { id: source.id }, data: { quantity: source.quantity.sub(input.quantity) } });
      const destination = await tx.inventoryStockBalance.upsert({
        where: { itemId_locationId: { itemId: id, locationId: to.id } },
        create: { institutionId, itemId: id, locationId: to.id, quantity: input.quantity },
        update: { quantity: { increment: input.quantity } },
      });
      if (destination.quantity.gt("1000000000")) throw new BadRequestError("Total stock at the destination is too large");
      const common = { institutionId, itemId: id, quantity: input.quantity, transferId: randomUUID(), recordedOn: new Date(`${input.recordedOn}T00:00:00Z`), notes: input.notes, createdById: req.user!.userId };
      await tx.inventoryStockMovement.create({ data: { ...common, kind: "TRANSFER_OUT", locationId: from.id, transferLocationId: to.id, transferLocationName: to.name, requestId: input.requestId } });
      await tx.inventoryStockMovement.create({ data: { ...common, kind: "TRANSFER_IN", locationId: to.id, transferLocationId: from.id, transferLocationName: from.name } });
    });
    const data = await academicDb().inventoryItem.findFirst({ where: { id, institutionId }, include });
    res.status(201).json({ success: true, data });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2002") return next(new ConflictError("This request was already recorded. Refresh the item before retrying."));
    if (code === "P2003") return next(new ConflictError("A selected location is no longer available"));
    next(err);
  }
});
export default router;
