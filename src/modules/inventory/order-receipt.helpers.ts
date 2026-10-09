import { Prisma } from "../../generated/prisma/client";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";
import { OrderLine, receiptProgress } from "./purchase-order.helpers";

export async function lockReceiptOrder(tx: Prisma.TransactionClient, institutionId: string, orderId?: string) {
  if (!orderId) return null;
  await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseOrder" WHERE "id" = ${orderId} AND "institutionId" = ${institutionId} FOR UPDATE`;
  const order = await tx.inventoryPurchaseOrder.findFirst({ where: { id: orderId, institutionId }, include: { receipts: true } });
  if (!order) throw new NotFoundError("Purchase order not found");
  return order;
}
export function validateOrderReceipt(order: NonNullable<Awaited<ReturnType<typeof lockReceiptOrder>>>, itemId: string, input: { purchaseOrderLine?: number; supplierId: string; locationId: string; deliveredQuantity: string; recordedOn: string }) {
  if (!["APPROVED", "PARTIALLY_RECEIVED"].includes(order.status)) throw new ConflictError("Only approved, open purchase orders can receive stock");
  const line = receiptProgress(order.lines as unknown as OrderLine[], order.receipts)[input.purchaseOrderLine!];
  if (!line || line.itemId !== itemId || order.supplierId !== input.supplierId || order.locationId !== input.locationId) throw new BadRequestError("Item, supplier and delivery location must match the purchase order");
  if (input.recordedOn < order.createdAt.toISOString().slice(0, 10)) throw new BadRequestError("Receipt date cannot be before the order was created");
  if (Number(input.deliveredQuantity) > line.pending) throw new ConflictError(`Delivered quantity exceeds the pending order quantity (${line.pending}). Refresh Orders.`);
}
export async function finishOrderReceipt(tx: Prisma.TransactionClient, order: NonNullable<Awaited<ReturnType<typeof lockReceiptOrder>>>, actorId: string, actorRole: string, requestId: string) {
  const receipts = await tx.inventoryStockMovement.findMany({ where: { institutionId: order.institutionId, purchaseOrderId: order.id } });
  const progress = receiptProgress(order.lines as unknown as OrderLine[], receipts);
  const status = progress.every(line => line.pending === 0) ? "COMPLETED" : "PARTIALLY_RECEIVED";
  await tx.inventoryPurchaseOrder.update({ where: { id: order.id }, data: { status, revision: { increment: 1 }, events: [...order.events as Prisma.JsonArray, { action: "RECEIVED", requestId, actorId, actorRole, at: new Date().toISOString() }] } });
}
