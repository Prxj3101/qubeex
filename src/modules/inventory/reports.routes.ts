import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { BadRequestError } from "../../utils/errors";

const router = Router();
const kinds = ["OPENING", "OPENING_CORRECTION", "RECEIPT", "ISSUE", "RETURN", "TRANSFER_OUT", "TRANSFER_IN", "ADJUSTMENT", "SUPPLIER_RETURN", "ISSUE_DAMAGED", "ISSUE_LOST"] as const;
const labels: Record<string, string> = { OPENING: "Opening stock", OPENING_CORRECTION: "Opening correction", RECEIPT: "Stock received", ISSUE: "Stock issued", RETURN: "Stock returned", TRANSFER_OUT: "Transfer out", TRANSFER_IN: "Transfer in", ADJUSTMENT: "Stock adjustment", SUPPLIER_RETURN: "Supplier return", ISSUE_DAMAGED: "Issued item damaged", ISSUE_LOST: "Issued item lost" };
const schema = z.object({
  report: z.enum(["stock", "movements", "returns", "lowstock"]).default("stock"),
  search: z.string().trim().max(120).default(""), locationId: z.string().uuid().optional(), categoryId: z.string().uuid().optional(),
  itemType: z.enum(["CONSUMABLE", "RETURNABLE", "FIXED_ASSET"]).optional(), kind: z.enum(kinds).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  returnStatus: z.enum(["pending", "overdue"]).default("pending"),
  asOf: z.iso.date().default(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })),
  page: z.coerce.number().int().min(1).max(1000000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict().refine(v => !v.from || !v.to || v.from <= v.to, "From date must be on or before To date");
type Cell = string | number;
const typeLabel = (type: string) => type === "CONSUMABLE" ? "Consumable" : type === "RETURNABLE" ? "Returnable equipment" : "Fixed asset";
const recipient = (type: string | null, custom: string) => type === "CUSTOM" ? custom : (type || "").toLowerCase().replaceAll("_", " ").replace(/\b\w/g, v => v.toUpperCase());

router.get("/reports", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = req.user?.institutionId;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || "Invalid report filters");
    const q = parsed.data, skip = (q.page - 1) * q.pageSize, db = academicDb();
    const itemWhere = { institutionId, ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.itemType ? { type: q.itemType } : {}), ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { code: { contains: q.search, mode: "insensitive" as const } }] } : {}) };
    let columns: string[], rows: { id: string; cells: Cell[] }[], total: number;
    if (q.report === "stock" || q.report === "lowstock") {
      const items = await db.inventoryItem.findMany({ where: { ...itemWhere, ...(q.locationId ? { balances: { some: { locationId: q.locationId } } } : {}) }, include: { category: true, unit: true, balances: { ...(q.locationId ? { where: { locationId: q.locationId } } : {}), include: { location: true }, orderBy: { location: { name: "asc" } } } }, orderBy: [{ name: "asc" }, { id: "asc" }] });
      const entries = items.map(item => {
        const quantity = item.balances.reduce((sum, b) => sum + Number(b.quantity), 0);
        const low = item.type === "CONSUMABLE" && Number(item.lowStockLevel) > 0 && quantity <= Number(item.lowStockLevel);
        return { item, quantity, low };
      }).filter(entry => q.report !== "lowstock" || entry.low);
      total = entries.length;
      columns = ["Item", "Item code / Serial no.", "Category", "Type", "Available quantity", "Unit", "Locations", "Low stock limit", "Status"];
      rows = entries.slice(skip, skip + q.pageSize).map(({ item, quantity, low }) => ({ id: item.id, cells: [item.name, item.code, item.category.name, typeLabel(item.type), quantity, item.unit.abbreviation || item.unit.name, item.balances.map(b => `${b.location.name}: ${Number(b.quantity).toLocaleString("en-IN")}`).join("; ") || "No stock recorded", Number(item.lowStockLevel), low ? "Low stock" : quantity > 0 ? "In stock" : "No stock"] }));
    } else if (q.report === "movements") {
      const where = { institutionId, item: itemWhere, ...(q.locationId ? { locationId: q.locationId } : {}), ...(q.kind ? { kind: q.kind } : {}), ...((q.from || q.to) ? { recordedOn: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(q.to ? { lte: new Date(`${q.to}T00:00:00Z`) } : {}) } } : {}) };
      const entries = await db.inventoryStockMovement.findMany({ where, include: { item: { include: { unit: true } }, location: true, purchaseOrder: { select: { number: true } } }, orderBy: [{ recordedOn: "desc" }, { createdAt: "desc" }, { id: "desc" }], skip, take: q.pageSize });
      total = await db.inventoryStockMovement.count({ where });
      const users = await prisma.user.findMany({ where: { institutionId, id: { in: [...new Set(entries.map(e => e.createdById))] } }, select: { id: true, name: true } });
      const names = new Map(users.map(u => [u.id, u.name || "School user"]));
      columns = ["Date", "Item", "Item code / Serial no.", "Movement", "Location", "Stock change", "Unit", "Delivered", "Rejected", "Previous quantity", "Updated quantity", "Recipient / Supplier / Other location", "Reason / Notes", "Bill number", "Recorded by", "Affected issued quantity", "Purchase order", "Recorded at"];
      rows = entries.map(e => {
        const adjustment = e.kind === "ADJUSTMENT" || e.kind === "OPENING_CORRECTION";
        const change = ["ISSUE_DAMAGED", "ISSUE_LOST"].includes(e.kind) ? 0 : adjustment ? Number(e.correctedQuantity) - Number(e.previousQuantity) : Number(e.quantity) * (["ISSUE", "TRANSFER_OUT", "SUPPLIER_RETURN"].includes(e.kind) ? -1 : 1);
        const related = (e.kind === "RECEIPT" || e.kind === "SUPPLIER_RETURN") ? e.supplierName : e.kind.startsWith("TRANSFER_") ? e.transferLocationName : e.issuedToName ? `${e.issuedToName} (${recipient(e.issuedToType, e.issuedToLabel)})` : "";
        return { id: e.id, cells: [e.recordedOn.toISOString().slice(0, 10), e.item.name, e.item.code, e.kind === "ADJUSTMENT" ? `Stock adjustment - ${e.adjustmentType === "DAMAGED" ? "Damaged" : e.adjustmentType === "LOST" ? "Lost" : "Count correction"}` : labels[e.kind] || e.kind, e.location.name, change, e.item.unit.abbreviation || e.item.unit.name, e.kind === "RECEIPT" ? Number(e.deliveredQuantity ?? e.quantity) : "", e.kind === "RECEIPT" ? Number(e.rejectedQuantity) : "", adjustment ? Number(e.previousQuantity) : "", adjustment ? Number(e.correctedQuantity) : "", related, [e.damageReason, e.notes].filter(Boolean).join(" - "), e.billNumber, names.get(e.createdById) || "Former school user", ["ISSUE_DAMAGED", "ISSUE_LOST"].includes(e.kind) ? Number(e.quantity) : "", e.purchaseOrder?.number || "", e.createdAt.toISOString()] };
      });
    } else {
      const entries = await db.inventoryStockMovement.findMany({ where: { institutionId, kind: "ISSUE", returnExpected: true, item: itemWhere, ...(q.locationId ? { locationId: q.locationId } : {}), ...(q.returnStatus === "overdue" ? { dueOn: { lt: new Date(`${q.asOf}T00:00:00Z`) } } : {}) }, include: { item: { include: { unit: true } }, location: true, returns: { select: { quantity: true, kind: true } } }, orderBy: [{ recordedOn: "asc" }, { id: "asc" }] });
      const pending = entries.map(e => ({ entry: e, returned: e.returns.filter(r => r.kind === "RETURN").reduce((sum,r) => sum + Number(r.quantity),0), closed: e.returns.reduce((sum,r) => sum + Number(r.quantity),0), damaged: e.returns.filter(r => r.kind === "ISSUE_DAMAGED").reduce((sum,r) => sum + Number(r.quantity),0), lost: e.returns.filter(r => r.kind === "ISSUE_LOST").reduce((sum,r) => sum + Number(r.quantity),0) })).filter(({ entry, closed }) => Number(entry.quantity) > closed);
      total = pending.length;
      columns = ["Item", "Item code / Serial no.", "Recipient", "Recipient type", "Location", "Issued", "Returned", "Pending", "Unit", "Issue date", "Return due", "Status", "Damaged", "Lost", "Recorded at"];
      rows = pending.slice(skip, skip + q.pageSize).map(({ entry: e, returned, closed, damaged, lost }) => ({ id: e.id, cells: [e.item.name, e.item.code, e.issuedToName, recipient(e.issuedToType, e.issuedToLabel), e.location.name, Number(e.quantity), returned, Number(e.quantity) - closed, e.item.unit.abbreviation || e.item.unit.name, e.recordedOn.toISOString().slice(0, 10), e.dueOn?.toISOString().slice(0, 10) || "", e.dueOn && e.dueOn.toISOString().slice(0, 10) < q.asOf ? "Overdue" : "Return pending", damaged, lost, e.createdAt.toISOString()] }));
    }
    const school = await prisma.institution.findUnique({ where: { id: institutionId }, select: { institutionCode: true } });
    const institutionAbbreviation = school?.institutionCode.match(/^QX-([^-]+)-/)?.[1] || school?.institutionCode.split("-")[0] || "Institution";
    res.json({ success: true, data: { columns, rows, total, page: q.page, pageSize: q.pageSize, institutionAbbreviation } });
  } catch (err) { next(err); }
});
export default router;
