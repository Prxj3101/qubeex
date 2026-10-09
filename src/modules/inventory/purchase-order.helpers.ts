import { Prisma } from "../../generated/prisma/client";
import { BadRequestError } from "../../utils/errors";

export interface OrderLine { itemId: string; requestedName: string; name: string; code: string; unit: string; quantity: number; unitPrice: string; taxPercent: string; subtotal: string; tax: string; total: string; cancelledQuantity: number }
export function priceLine(quantity: number, unitPrice: string, taxPercent: string) {
  const subtotal = new Prisma.Decimal(unitPrice).mul(quantity).toDecimalPlaces(2);
  const tax = subtotal.mul(taxPercent).div(100).toDecimalPlaces(2);
  return { subtotal: subtotal.toFixed(2), tax: tax.toFixed(2), total: subtotal.add(tax).toFixed(2) };
}
export function receiptProgress(lines: OrderLine[], receipts: { purchaseOrderLine: number | null; quantity: Prisma.Decimal; deliveredQuantity: Prisma.Decimal | null; rejectedQuantity: Prisma.Decimal }[]) {
  return lines.map((line, index) => {
    const entries = receipts.filter(receipt => receipt.purchaseOrderLine === index);
    const accepted = entries.reduce((sum, receipt) => sum + Number(receipt.quantity), 0);
    const delivered = entries.reduce((sum, receipt) => sum + Number(receipt.deliveredQuantity ?? receipt.quantity), 0);
    const rejected = entries.reduce((sum, receipt) => sum + Number(receipt.rejectedQuantity), 0);
    return { ...line, accepted, delivered, rejected, pending: Math.max(0, line.quantity - accepted - line.cancelledQuantity) };
  });
}
export function assertTotal(lines: OrderLine[]) {
  const total = lines.reduce((sum, line) => sum.add(line.total), new Prisma.Decimal(0));
  if (total.gt(1000000000)) throw new BadRequestError("Order total must be no more than INR 1,000,000,000");
  return total;
}
