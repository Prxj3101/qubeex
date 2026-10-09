import { Router, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors";
import { Prisma } from "../../generated/prisma/client";
import { OrderLine, assertTotal, priceLine, receiptProgress } from "./purchase-order.helpers";

const router = Router(), uuid = z.string().uuid();
const money = z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter an amount with up to 2 decimal places").refine(value => Number(value) <= 1000000000, "Price is too large");
const fields = z.object({ supplierId: uuid, locationId: uuid, expectedOn: z.iso.date(), instructions: z.string().trim().max(1000).default(""), lines: z.array(z.object({ itemId: uuid, unitPrice: money, taxPercent: money.refine(value => Number(value) <= 100, "Tax must be between 0 and 100") }).strict()).min(1).max(20) }).strict();
const createSchema = fields.extend({ purchaseRequestId: uuid });
const editSchema = fields.extend({ revision: z.number().int().positive() });
const reviewSchema = z.object({ revision: z.number().int().positive(), decision: z.enum(["APPROVED", "REJECTED"]), reason: z.string().trim().max(1000).default("") }).strict();
const closeSchema = z.object({ revision: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict();
const include = { receipts: { orderBy: { createdAt: "desc" as const } } };
function parse<T>(schema: z.ZodType<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) throw new BadRequestError(result.error.issues[0]?.message || "Invalid order details"); return result.data; }
function school(req: AuthRequest) { if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account"); return req.user.institutionId; }
const event = (req: AuthRequest, action: string, reason = "") => ({ action, reason, actorId: req.user!.userId, actorRole: req.user!.role, at: new Date().toISOString() });
const serialize = (order: { lines: Prisma.JsonValue; receipts: Parameters<typeof receiptProgress>[1] }) => ({ ...order, lines: receiptProgress(order.lines as unknown as OrderLine[], order.receipts) });
async function build(tx: Prisma.TransactionClient, institutionId: string, input: z.infer<typeof fields>, requestLines: { name: string; quantity: number; unit: string }[]) {
  if (input.lines.length !== requestLines.length) throw new BadRequestError("Include every item from the approved request");
  const supplier = await tx.inventorySupplier.findFirst({ where: { id: input.supplierId, institutionId } });
  const location = await tx.inventoryLocation.findFirst({ where: { id: input.locationId, institutionId } });
  if (!supplier || !location) throw new BadRequestError("Select a supplier and delivery location from your school");
  for (const itemId of [...new Set(input.lines.map(line => line.itemId))].sort()) {
    await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${itemId} AND "institutionId" = ${institutionId} FOR SHARE`;
  }
  const items = await tx.inventoryItem.findMany({ where: { institutionId, id: { in: input.lines.map(line => line.itemId) } }, include: { unit: true } });
  const lines = input.lines.map((line, index) => {
    const item = items.find(item => item.id === line.itemId), requested = requestLines[index];
    if (!item) throw new BadRequestError("Select inventory items from your school for all order lines");
    const requestedUnit = requested.unit.trim().toLowerCase();
    if (![item.unit.name, item.unit.abbreviation].filter(Boolean).some(unit => unit.toLowerCase() === requestedUnit)) throw new BadRequestError(`Unit for ${requested.name} must match the inventory item (${item.unit.abbreviation || item.unit.name})`);
    return { itemId: item.id, requestedName: requested.name, name: item.name, code: item.code, unit: item.unit.abbreviation || item.unit.name, quantity: requested.quantity, unitPrice: new Prisma.Decimal(line.unitPrice).toFixed(2), taxPercent: new Prisma.Decimal(line.taxPercent).toFixed(2), ...priceLine(requested.quantity, line.unitPrice, line.taxPercent), cancelledQuantity: 0 };
  });
  return { supplierId: supplier.id, supplierSnapshot: { name: supplier.name, contactPerson: supplier.contactPerson, phone: supplier.phone, email: supplier.email, address: supplier.address }, locationId: location.id, locationName: location.name, expectedOn: new Date(input.expectedOn + "T00:00:00Z"), instructions: input.instructions, lines, total: assertTotal(lines) };
}
router.get("/purchase-orders", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = parse(z.coerce.number().int().min(1).max(100000).default(1), req.query.page), where = { institutionId: school(req) };
    const [data, count] = await Promise.all([academicDb().inventoryPurchaseOrder.findMany({ where, include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, skip: (page - 1) * 50 }), academicDb().inventoryPurchaseOrder.count({ where })]);
    res.json({ success: true, data: data.map(serialize), count, page });
  } catch (err) { next(err); }
});
router.post("/purchase-orders", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const input = parse(createSchema, req.body), institutionId = school(req);
    const data = await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseRequest" WHERE "id" = ${input.purchaseRequestId} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const request = await tx.inventoryPurchaseRequest.findFirst({ where: { id: input.purchaseRequestId, institutionId } });
      if (!request) throw new NotFoundError("Purchase request not found");
      if (request.status !== "APPROVED") throw new ConflictError("Only approved requests can become purchase orders");
      const existing = await tx.inventoryPurchaseOrder.findFirst({ where: { purchaseRequestId: request.id, institutionId } });
      if (existing) throw new ConflictError(`Order ${existing.number} already exists for this request. Open Orders to view or edit it.`);
      const details = await build(tx, institutionId, input, request.lines as { name: string; unit: string; quantity: number }[]);
      return tx.inventoryPurchaseOrder.create({ data: { ...details, institutionId, purchaseRequestId: request.id, number: `PO-${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, createdById: req.user!.userId, events: [{ ...event(req, "SUBMITTED"), snapshot: { ...details, total: details.total.toFixed(2), expectedOn: details.expectedOn.toISOString() } }] }, include });
    });
    res.status(201).json({ success: true, data: serialize(data) });
  } catch (err) { if ((err as { code?: string })?.code === "P2002") return next(new ConflictError("An order already exists for this request. Refresh Orders.")); next(err); }
});
router.patch("/purchase-orders/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parse(uuid, req.params.id), input = parse(editSchema, req.body), institutionId = school(req);
    const data = await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseOrder" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const order = await tx.inventoryPurchaseOrder.findFirst({ where: { id, institutionId }, include: { purchaseRequest: true } });
      if (!order) throw new NotFoundError("Order not found");
      if (req.user!.role !== "ADMIN" && order.createdById !== req.user!.userId) throw new ForbiddenError("Only the order creator or admin can edit this order");
      if (!["PENDING", "REJECTED"].includes(order.status) || order.revision !== input.revision) throw new ConflictError("Order changed or is no longer editable. Refresh Orders.");
      const details = await build(tx, institutionId, input, order.purchaseRequest.lines as { name: string; unit: string; quantity: number }[]);
      return tx.inventoryPurchaseOrder.update({ where: { id }, data: { ...details, status: "PENDING", revision: { increment: 1 }, events: [...order.events as Prisma.JsonArray, { ...event(req, "RESUBMITTED"), snapshot: { ...details, total: details.total.toFixed(2), expectedOn: details.expectedOn.toISOString() } }] }, include });
    });
    res.json({ success: true, data: serialize(data) });
  } catch (err) { next(err); }
});
router.post("/purchase-orders/:id/review", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== "ADMIN") throw new ForbiddenError("Only an admin can approve purchase orders");
    const id = parse(uuid, req.params.id), input = parse(reviewSchema, req.body), institutionId = school(req);
    if (input.decision === "REJECTED" && !input.reason) throw new BadRequestError("Enter a rejection reason");
    const data = await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseOrder" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const order = await tx.inventoryPurchaseOrder.findFirst({ where: { id, institutionId } });
      if (!order) throw new NotFoundError("Order not found");
      if (order.status !== "PENDING" || order.revision !== input.revision) throw new ConflictError("Order changed or was already reviewed. Refresh Orders.");
      return tx.inventoryPurchaseOrder.update({ where: { id }, data: { status: input.decision, revision: { increment: 1 }, events: [...order.events as Prisma.JsonArray, event(req, input.decision, input.reason)] }, include });
    });
    res.json({ success: true, data: serialize(data) });
  } catch (err) { next(err); }
});
router.post("/purchase-orders/:id/close", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== "ADMIN") throw new ForbiddenError("Only an admin can cancel the remaining order quantity");
    const id = parse(uuid, req.params.id), input = parse(closeSchema, req.body), institutionId = school(req);
    const data = await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseOrder" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const order = await tx.inventoryPurchaseOrder.findFirst({ where: { id, institutionId }, include });
      if (!order) throw new NotFoundError("Order not found");
      if (!["APPROVED", "PARTIALLY_RECEIVED"].includes(order.status) || order.revision !== input.revision) throw new ConflictError("Order changed or cannot be closed. Refresh Orders.");
      const progress = receiptProgress(order.lines as unknown as OrderLine[], order.receipts);
      const lines = (order.lines as unknown as OrderLine[]).map((line, index) => ({ ...line, cancelledQuantity: line.cancelledQuantity + progress[index].pending }));
      return tx.inventoryPurchaseOrder.update({ where: { id }, data: { status: "CLOSED", lines, revision: { increment: 1 }, events: [...order.events as Prisma.JsonArray, event(req, "CLOSED", input.reason)] }, include });
    });
    res.json({ success: true, data: serialize(data) });
  } catch (err) { next(err); }
});
router.get("/purchase-orders/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parse(uuid, req.params.id), institutionId = school(req);
    const order = await academicDb().inventoryPurchaseOrder.findFirst({ where: { id, institutionId }, include });
    if (!order) throw new NotFoundError("Order not found");
    res.json({ success: true, data: serialize(order) });
  } catch (err) { next(err); }
});
router.get("/purchase-orders/:id/pdf", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = school(req), id = parse(uuid, req.params.id);
    const order = await academicDb().inventoryPurchaseOrder.findFirst({ where: { id, institutionId } });
    if (!order) throw new NotFoundError("Order not found");
    if (["PENDING", "REJECTED"].includes(order.status)) throw new ConflictError("Approve the order before downloading it for the supplier");
    const institution = await prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true, address: true, phone: true } });
    const supplier = order.supplierSnapshot as { name: string; address: string; phone: string; email: string };
    const doc = new PDFDocument({ margin: 45, size: "A4" });
    res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `attachment; filename="${order.number}.pdf"`);
    doc.on("error", error => res.destroy(error)); doc.pipe(res);
    doc.fontSize(18).text(institution?.name || "School").fontSize(10).text(institution?.address || "").text(institution?.phone || "").moveDown();
    doc.fontSize(16).text("PURCHASE ORDER").fontSize(10).text(order.number).text(`Status: ${order.status.replaceAll("_", " ")}`).text(`Expected delivery: ${order.expectedOn.toISOString().slice(0, 10)}`).text(`Delivery location: ${order.locationName}`).moveDown();
    doc.font("Helvetica-Bold").text(`Supplier: ${supplier.name}`).font("Helvetica").text(supplier.address || "").text([supplier.phone, supplier.email].filter(Boolean).join(" | ")).moveDown();
    (order.lines as unknown as OrderLine[]).forEach((line, index) => {
      if (doc.y > 650) doc.addPage();
      doc.font("Helvetica-Bold").text(`${index + 1}. ${line.name} (${line.code})`).font("Helvetica").text(`Quantity: ${line.quantity} ${line.unit} | Unit price: INR ${line.unitPrice} | Tax: ${line.taxPercent}%`).text(`Subtotal: INR ${line.subtotal} | Tax amount: INR ${line.tax} | Line total: INR ${line.total}`);
      if (line.cancelledQuantity > 0) doc.text(`Cancelled quantity: ${line.cancelledQuantity}`);
      doc.moveDown();
    });
    if (doc.y > 650) doc.addPage();
    doc.font("Helvetica-Bold").fontSize(12).text(`ORDER TOTAL: INR ${order.total.toFixed(2)}`).font("Helvetica").fontSize(10).moveDown();
    if (order.instructions) doc.text(`Instructions: ${order.instructions}`).moveDown();
    doc.text("Approved electronically by the school administration."); doc.end();
  } catch (err) { next(err); }
});
export default router;
