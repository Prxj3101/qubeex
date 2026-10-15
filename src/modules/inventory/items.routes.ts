import { QUANTITY_PATTERN, QUANTITY_MESSAGE, isWhole, subtractQuantity } from "./quantity";
import { lockReceiptOrder, validateOrderReceipt, finishOrderReceipt } from "./order-receipt.helpers";
import { receiptUpload } from "./receipt-upload";
import { uploadAttachmentToR2, scheduleR2FileDeletion } from "../../services/storage.service";
import { prisma } from '../../utils/prisma';
import { createHash, randomUUID } from "node:crypto";
import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";

const router = Router();
const idSchema = z.string().uuid();
const quantitySchema = z.string().trim().regex(QUANTITY_PATTERN, QUANTITY_MESSAGE).refine(v => Number(v) <= 1_000_000_000, "Quantity is too large");
const itemSchema = z.object({
  name: z.string().trim().min(1).max(120).transform(v => v.replace(/\s+/g, " ")),
  code: z.string().trim().max(40).regex(/^[A-Za-z0-9_-]*$/, "Use letters, numbers, hyphens or underscores for item codes").transform(v => v.toUpperCase()).default(""),
  description: z.string().trim().max(500).default(""),
  type: z.enum(["CONSUMABLE", "RETURNABLE", "FIXED_ASSET"]),
  categoryId: idSchema,
  unitId: idSchema,
  lowStockLevel: quantitySchema.default("0"),
}).strict().refine(v => v.type === "CONSUMABLE" || Number.isInteger(Number(v.lowStockLevel)), "Equipment and assets must use whole quantities");
const openingSchema = z.object({
  locationId: idSchema,
  quantity: quantitySchema.refine(v => Number(v) > 0, "Opening quantity must be greater than zero"),
  recordedOn: z.iso.date(),
  notes: z.string().trim().min(1, "Enter opening stock notes").max(500),
}).strict();
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestError(result.error.issues[0]?.message || "Invalid inventory details");
  return result.data;
};
const institution = (req: AuthRequest) => {
  if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account");
  return req.user.institutionId;
};
const handleError = (err: unknown, next: NextFunction) => {
  const code = (err as { code?: string })?.code;
  if (code === "P2002") return next(new ConflictError("Item code already exists, or opening stock is already recorded for this location"));
  if (code === "P2003") return next(new ConflictError("This record is in use or a selected setup record is no longer available"));
  next(err);
};
const include = { movements: { select: { kind: true, locationId: true } }, category: { select: { id: true, name: true } }, unit: { select: { id: true, name: true, abbreviation: true } }, balances: { include: { location: { select: { id: true, name: true } } } } };

router.get("/items", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await academicDb().inventoryItem.findMany({ where: { institutionId: institution(req) }, orderBy: { name: "asc" }, include });
    res.json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
router.get("/summary", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const db = academicDb();
    const [items, locations] = await Promise.all([
      db.inventoryItem.findMany({ where: { institutionId }, include: { balances: true } }),
      db.inventoryLocation.count({ where: { institutionId } }),
    ]);
    res.json({ success: true, data: {
      stockItems: items.filter(i => i.type !== "FIXED_ASSET").length,
      schoolAssets: items.filter(i => i.type === "FIXED_ASSET").length,
      lowStock: items.filter(i => i.type === "CONSUMABLE" && Number(i.lowStockLevel) > 0 && i.balances.reduce((sum, b) => sum + Number(b.quantity), 0) <= Number(i.lowStockLevel)).length,
      locations, totalItems: items.length,
    } });
  } catch (err) { handleError(err, next); }
});
router.post("/items", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const input = parse(itemSchema, req.body);
    const db = academicDb();
    const [category, unit] = await Promise.all([
      db.inventoryCategory.findFirst({ where: { id: input.categoryId, institutionId } }),
      db.inventoryUnit.findFirst({ where: { id: input.unitId, institutionId } }),
    ]);
    if (!category || !unit) throw new BadRequestError("Select a category and unit from your school setup");
    const data = await db.inventoryItem.create({ data: { ...input, institutionId, code: input.code || `ITM-${randomUUID().slice(0, 12).replace(/-/g, "").toUpperCase()}` }, include });
    res.status(201).json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
router.patch("/items/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const id = parse(idSchema, req.params.id);
    const input = parse(itemSchema, req.body);
    const data = await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id, institutionId }, include: { _count: { select: { movements: true } } } });
      if (!item) throw new NotFoundError("Item not found");
      const referencedByOrder = await tx.inventoryPurchaseOrder.count({ where: { institutionId, lines: { array_contains: [{ itemId: id }] } } });
      if ((item._count.movements || referencedByOrder) && (item.unitId !== input.unitId || item.type !== input.type)) throw new ConflictError("Unit and type cannot change after stock or a purchase order has been recorded");
      const [category, unit] = await Promise.all([
        tx.inventoryCategory.findFirst({ where: { id: input.categoryId, institutionId } }),
        tx.inventoryUnit.findFirst({ where: { id: input.unitId, institutionId } }),
      ]);
      if (!category || !unit) throw new BadRequestError("Select a category and unit from your school setup");
      return tx.inventoryItem.update({ where: { id }, data: { ...input, code: input.code || item.code }, include });
    });
    res.json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
router.delete("/items/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const id = parse(idSchema, req.params.id);
    await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id, institutionId }, include: { _count: { select: { balances: true, movements: true } } } });
      if (!item) throw new NotFoundError("Item not found");
      if (item._count.balances || item._count.movements || await tx.inventoryPurchaseOrder.count({ where: { institutionId, lines: { array_contains: [{ itemId: id }] } } })) throw new ConflictError("Items used in stock records or purchase orders cannot be deleted");
      await tx.inventoryItem.delete({ where: { id } });
    });
    res.json({ success: true });
  } catch (err) { handleError(err, next); }
});
router.post("/items/:id/opening-stock", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const id = parse(idSchema, req.params.id);
    const input = parse(openingSchema, req.body);
    await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id, institutionId } });
      if (!item) throw new NotFoundError("Item not found");
      if (item.type !== "CONSUMABLE" && !Number.isInteger(Number(input.quantity))) throw new BadRequestError("Equipment and assets must use whole quantities");
      const location = await tx.inventoryLocation.findFirst({ where: { id: input.locationId, institutionId } });
      if (!location) throw new BadRequestError("Select a location from your school setup");
      const existing = await tx.inventoryStockBalance.findUnique({ where: { itemId_locationId: { itemId: id, locationId: input.locationId } } });
      if (existing) throw new ConflictError("Opening stock is already recorded for this item at this location");
      await tx.inventoryStockBalance.create({ data: { institutionId, itemId: id, locationId: input.locationId, quantity: input.quantity } });
      await tx.inventoryStockMovement.create({ data: { institutionId, itemId: id, locationId: input.locationId, quantity: input.quantity, kind: "OPENING", recordedOn: new Date(`${input.recordedOn}T00:00:00.000Z`), notes: input.notes, createdById: req.user!.userId } });
    });
    const data = await academicDb().inventoryItem.findFirst({ where: { id, institutionId }, include });
    res.status(201).json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
const correctionSchema = z.object({
  locationId: idSchema,
  quantity: quantitySchema,
  expectedQuantity: z.string().trim().regex(/^\d{1,10}(\.\d{1,3})?$/).refine(v => Number(v) <= 1_000_000_000, "Quantity is too large"),
  reason: z.string().trim().min(1, "Enter a correction reason").max(500),
}).strict();

router.patch("/items/:id/opening-stock", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const id = parse(idSchema, req.params.id);
    const input = parse(correctionSchema, req.body);
    await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id, institutionId } });
      if (!item) throw new NotFoundError("Item not found");
      if (item.type !== "CONSUMABLE" && !Number.isInteger(Number(input.quantity))) throw new BadRequestError("Equipment and assets must use whole quantities");
      const balance = await tx.inventoryStockBalance.findFirst({ where: { institutionId, itemId: id, locationId: input.locationId } });
      if (!balance) throw new NotFoundError("Opening stock not found for this location");
      if (!balance.quantity.equals(input.expectedQuantity)) throw new ConflictError("Stock changed since this form was opened. Refresh and try again");
      if (balance.quantity.equals(input.quantity)) throw new BadRequestError("Enter a different quantity to make a correction");
      const entries = await tx.inventoryStockMovement.findMany({ where: { institutionId, itemId: id, locationId: input.locationId }, orderBy: { createdAt: "asc" } });
      const openingEntry = entries.find(entry => entry.kind === "OPENING");
      if (!openingEntry) throw new ConflictError("There is no opening entry to correct at this location");
      if (entries.some(entry => entry.kind !== "OPENING" && entry.kind !== "OPENING_CORRECTION")) throw new ConflictError("Stock activity has already started at this location. Use Stock Adjustment to correct the count");
      await tx.inventoryStockMovement.create({ data: {
        institutionId, itemId: id, locationId: input.locationId, kind: "OPENING_CORRECTION",
        quantity: balance.quantity.sub(input.quantity).abs(), previousQuantity: balance.quantity, correctedQuantity: input.quantity,
        recordedOn: openingEntry.recordedOn, notes: input.reason, createdById: req.user!.userId,
      } });
      await tx.inventoryStockBalance.update({ where: { id: balance.id }, data: { quantity: input.quantity } });
    });
    const data = await academicDb().inventoryItem.findFirst({ where: { id, institutionId }, include });
    res.json({ success: true, data });
  } catch (err) { handleError(err, next); }
});

router.get("/items/:id/stock-history", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req);
    const id = parse(idSchema, req.params.id);
    const locationId = parse(idSchema, req.query.locationId);
    const item = await academicDb().inventoryItem.findFirst({ where: { id, institutionId }, select: { id: true } });
    if (!item) throw new NotFoundError("Item not found");
    const data = await academicDb().inventoryStockMovement.findMany({ where: { institutionId, itemId: id, locationId }, include: { purchaseOrder: { select: { number: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const users = await prisma.user.findMany({ where: { institutionId, id: { in: [...new Set(data.map(entry => entry.createdById))] } }, select: { id: true, name: true } });
    const names = new Map(users.map(user => [user.id, user.name || "School user"]));
    res.json({ success: true, data: data.map(entry => ({ ...entry, createdByName: names.get(entry.createdById) || "Former school user" })) });
  } catch (err) { handleError(err, next); }
});

const receiptSchema = z.object({
  purchaseOrderId: idSchema.optional(), purchaseOrderLine: z.number().int().min(0).max(19).optional(),
  requestId: idSchema, locationId: idSchema, supplierId: idSchema,
  quantity: quantitySchema.optional(),
  deliveredQuantity: quantitySchema.optional(),
  rejectedQuantity: quantitySchema.default("0"),
  damageReason: z.string().trim().max(500).default(""),
  recordedOn: z.iso.date(),
  billNumber: z.string().trim().max(80).default(""),
  billDate: z.iso.date().nullable().default(null),
  totalCost: z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter a cost with up to 2 decimal places").refine(v => Number(v) <= 1_000_000_000, "Cost is too large").nullable().default(null),
  notes: z.string().trim().max(500).default(""),
}).strict().superRefine((value, ctx) => {
  if ((value.purchaseOrderId !== undefined) !== (value.purchaseOrderLine !== undefined)) ctx.addIssue({ code: "custom", message: "Select both purchase order and order line" });
  const delivered = Number(value.deliveredQuantity ?? value.quantity), rejected = Number(value.rejectedQuantity);
  if (!(delivered > 0)) ctx.addIssue({ code: "custom", message: "Enter a delivered quantity greater than zero" });
  if (rejected > delivered) ctx.addIssue({ code: "custom", message: "Damaged/rejected quantity cannot exceed delivered quantity" });
  if (rejected > 0 && !value.damageReason) ctx.addIssue({ code: "custom", message: "Enter why these items were damaged or rejected" });
  if (value.deliveredQuantity !== undefined && value.quantity !== undefined && Number(value.quantity) !== Number(subtractQuantity(delivered, rejected))) ctx.addIssue({ code: "custom", message: "Accepted quantity does not match delivered minus rejected quantity" });
}).transform(value => ({ ...value,
  deliveredQuantity: value.deliveredQuantity ?? value.quantity!,
  quantity: subtractQuantity(value.deliveredQuantity ?? value.quantity!, value.rejectedQuantity),
  damageReason: Number(value.rejectedQuantity) > 0 ? value.damageReason : "",
}));


router.post("/items/:id/receive-stock", receiptUpload, async (req: AuthRequest, res: Response, next: NextFunction) => {
  const uploadedKeys: string[] = [];
  let committed = false;
  try {
    const institutionId = institution(req);
    const id = parse(idSchema, req.params.id);
    let body = req.body;
    if (req.is("multipart/form-data")) {
      try { body = JSON.parse(req.body?.payload); } catch { throw new BadRequestError("Invalid receipt details"); }
    }
    const input = parse(receiptSchema, body);
    const files = (req.files || []) as Express.Multer.File[];
    const fingerprints = files.map(file => ({ name: file.originalname, type: file.mimetype, size: file.size, sha256: createHash("sha256").update(file.buffer).digest("hex") }));
    await academicDb().$transaction(async tx => {
      const linkedOrder = await lockReceiptOrder(tx, institutionId, input.purchaseOrderId);
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id, institutionId } });
      if (!item) throw new NotFoundError("Item not found");
      if (item.type !== "CONSUMABLE" && !(isWhole(input.quantity) && isWhole(input.deliveredQuantity) && isWhole(input.rejectedQuantity))) throw new BadRequestError("Equipment and assets must use whole quantities");
      const existing = await tx.inventoryStockMovement.findFirst({ where: { institutionId, requestId: input.requestId } });
      if (existing) {
        const savedFiles = Array.isArray(existing.attachments) ? existing.attachments as { name: string; type: string; size: number; sha256: string }[] : [];
        if (JSON.stringify(savedFiles.map(({ name, type, size, sha256 }) => ({ name, type, size, sha256 }))) !== JSON.stringify(fingerprints)) throw new ConflictError("This receipt request was already used with different attachments");
        if ((existing.purchaseOrderId ?? null) !== (input.purchaseOrderId ?? null) || (existing.purchaseOrderLine ?? null) !== (input.purchaseOrderLine ?? null) || existing.kind !== "RECEIPT" || existing.itemId !== id || existing.locationId !== input.locationId || existing.supplierId !== input.supplierId || !existing.quantity.equals(input.quantity) || existing.recordedOn.toISOString().slice(0, 10) !== input.recordedOn || existing.billNumber !== input.billNumber || (existing.billDate?.toISOString().slice(0, 10) || null) !== input.billDate || (existing.totalCost === null ? input.totalCost !== null : input.totalCost === null || !existing.totalCost.equals(input.totalCost)) || existing.notes !== input.notes || Number(existing.deliveredQuantity ?? existing.quantity) !== Number(input.deliveredQuantity) || Number(existing.rejectedQuantity || 0) !== Number(input.rejectedQuantity) || (existing.damageReason || "") !== input.damageReason) throw new ConflictError("This receipt request was already used with different details");
        return;
      }
      if (linkedOrder) validateOrderReceipt(linkedOrder, id, input);
      const supplier = await tx.inventorySupplier.findFirst({ where: { id: input.supplierId, institutionId } });
      const location = await tx.inventoryLocation.findFirst({ where: { id: input.locationId, institutionId } });
      if (!supplier || !location) throw new BadRequestError("Select a supplier and location from your school setup");
      const attachments: { url: string; name: string; type: string; size: number; sha256: string }[] = [];
      for (const [index, file] of files.entries()) {
        const uploaded = await uploadAttachmentToR2(file.buffer, { originalName: file.originalname, contentType: file.mimetype, institutionId, area: "inventory/bills" });
        uploadedKeys.push(uploaded.path);
        attachments.push({ ...fingerprints[index], url: uploaded.publicUrl });
      }
      const balance = await tx.inventoryStockBalance.upsert({
        where: { itemId_locationId: { itemId: id, locationId: input.locationId } },
        create: { institutionId, itemId: id, locationId: input.locationId, quantity: input.quantity },
        update: { quantity: { increment: input.quantity } },
      });
      if (balance.quantity.gt("1000000000")) throw new BadRequestError("Total stock at this location is too large");
      await tx.inventoryStockMovement.create({ data: {
        institutionId, itemId: id, locationId: input.locationId, kind: "RECEIPT", purchaseOrderId: input.purchaseOrderId, purchaseOrderLine: input.purchaseOrderLine, quantity: input.quantity, deliveredQuantity: input.deliveredQuantity, rejectedQuantity: input.rejectedQuantity, damageReason: input.damageReason,
        supplierId: supplier.id, supplierName: supplier.name, requestId: input.requestId,
        recordedOn: new Date(`${input.recordedOn}T00:00:00Z`), billNumber: input.billNumber,
        billDate: input.billDate ? new Date(`${input.billDate}T00:00:00Z`) : null,
        totalCost: input.totalCost, notes: input.notes, attachments, createdById: req.user!.userId,
      } });
      if (linkedOrder) await finishOrderReceipt(tx, linkedOrder, req.user!.userId, req.user!.role, input.requestId);
    });
    committed = true;
    const data = await academicDb().inventoryItem.findFirst({ where: { id, institutionId }, include });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (!committed) await Promise.allSettled(uploadedKeys.map(key => scheduleR2FileDeletion(key)));
    handleError(err, next);
  }
});

export default router;
