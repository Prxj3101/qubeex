import { movementUpload, uploadMovementFiles, checkMovementFiles, commitMovementFiles } from "./movement-files";
import { movementTime, occurredAt, checkEventOrder } from "./movement-time";
import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";

const router = Router();
const idSchema = z.string().uuid();
const quantity = z.string().trim().regex(/^\d{1,10}$/, "Enter a whole-number quantity").refine(v => Number(v) > 0 && Number(v) <= 1_000_000_000, "Enter a quantity greater than zero, up to 1,000,000,000");
const issueSchema = z.object({
  requestId: idSchema, locationId: idSchema, quantity, recordedOn: z.iso.date(), recordedTime: movementTime,
  issuedToType: z.enum(["PRINCIPAL","VICE_PRINCIPAL","HEAD_MASTER","HEAD_MISTRESS","DIRECTOR","ADMINISTRATOR","COORDINATOR","DEAN","RECTOR","SUPERINTENDENT","CHAIRMAN","SECRETARY","TRUSTEE","TEACHER","STUDENT","LIBRARIAN","ACCOUNTANT","CLERK","RECEPTIONIST","LAB_ASSISTANT","SPORTS_COACH","IT_STAFF","PEON","DRIVER","SECURITY_GUARD","HOUSEKEEPING","CLASSROOM","DEPARTMENT","CUSTOM"]),
  issuedToLabel: z.string().trim().max(80).transform(v => v.replace(/\s+/g, " ")).default(""),
  issuedToName: z.string().trim().min(1, "Enter who receives this item").max(120).transform(v => v.replace(/\s+/g, " ")),
  dueOn: z.iso.date().nullable().default(null), notes: z.string().trim().max(500).default(""),
}).strict().refine(v => v.issuedToType === "CUSTOM" ? !!v.issuedToLabel : !v.issuedToLabel, "Enter a custom recipient type only when Custom is selected").refine(v => !v.dueOn || v.dueOn >= v.recordedOn, "Return due date cannot be before the issue date");
const returnSchema = z.object({ requestId: idSchema, issueId: idSchema, quantity, recordedOn: z.iso.date(), recordedTime: movementTime, notes: z.string().trim().max(500).default("") }).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestError(result.error.issues[0]?.message || "Invalid stock details");
  return result.data;
}
function institution(req: AuthRequest) {
  if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account");
  return req.user.institutionId;
}
const include = { movements: { select: { kind: true, locationId: true } }, category: { select: { id: true, name: true } }, unit: { select: { id: true, name: true, abbreviation: true } }, balances: { include: { location: { select: { id: true, name: true } } } } };
const handleError = (err: unknown, next: NextFunction) => {
  if ((err as { code?: string })?.code === "P2002") return next(new ConflictError("This request was already recorded. Refresh the item before retrying."));
  if ((err as { code?: string })?.code === "P2003") return next(new ConflictError("A selected stock record is no longer available"));
  next(err);
};

router.post("/items/:id/issue-stock", movementUpload, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req), id = parse(idSchema, req.params.id), input = parse(issueSchema, req.body);
    await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id, institutionId } });
      if (!item) throw new NotFoundError("Item not found");
      if (item.type !== "CONSUMABLE" && !Number.isInteger(Number(input.quantity))) throw new BadRequestError("Equipment and assets must use whole quantities");
      if (item.type === "CONSUMABLE" && input.dueOn) throw new BadRequestError("Consumables do not have a return due date");
      const existing = await tx.inventoryStockMovement.findFirst({ where: { institutionId, requestId: input.requestId } });
      if (existing) {
        checkMovementFiles(req, existing.attachments);
        if (existing.kind !== "ISSUE" || existing.itemId !== id || existing.locationId !== input.locationId || !existing.quantity.equals(input.quantity) || existing.recordedOn.toISOString().slice(0, 10) !== input.recordedOn || existing.issuedToType !== input.issuedToType || existing.issuedToName !== input.issuedToName || (existing.issuedToLabel || "") !== input.issuedToLabel || (existing.dueOn?.toISOString().slice(0, 10) || null) !== input.dueOn || existing.notes !== input.notes || (existing.occurredAt?.toISOString() || null) !== (occurredAt(input.recordedOn, input.recordedTime)?.toISOString() || null)) throw new ConflictError("This issue request was already used with different details");
        return;
      }
      const balance = await tx.inventoryStockBalance.findFirst({ where: { institutionId, itemId: id, locationId: input.locationId } });
      if (!balance) throw new BadRequestError("Select a location with available stock for this item");
      if (balance.quantity.lt(input.quantity)) throw new ConflictError("Not enough stock at this location. Refresh and check the available quantity.");
      await tx.inventoryStockBalance.update({ where: { id: balance.id }, data: { quantity: balance.quantity.sub(input.quantity) } });
      const attachments = await uploadMovementFiles(req, institutionId);
      await tx.inventoryStockMovement.create({ data: { attachments,
        institutionId, itemId: id, locationId: input.locationId, kind: "ISSUE", quantity: input.quantity,
        requestId: input.requestId, issuedToType: input.issuedToType, issuedToName: input.issuedToName, issuedToLabel: input.issuedToLabel,
        returnExpected: item.type !== "CONSUMABLE", dueOn: input.dueOn ? new Date(`${input.dueOn}T00:00:00Z`) : null,
        recordedOn: new Date(`${input.recordedOn}T00:00:00Z`), occurredAt: occurredAt(input.recordedOn, input.recordedTime), notes: input.notes, createdById: req.user!.userId,
      } });
    }, { timeout: 30000 });
    commitMovementFiles(req);
    const data = await academicDb().inventoryItem.findFirst({ where: { id, institutionId }, include });
    res.status(201).json({ success: true, data });
  } catch (err) { handleError(err, next); }
});

router.get("/items/:id/issues", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req), id = parse(idSchema, req.params.id);
    const item = await academicDb().inventoryItem.findFirst({ where: { id, institutionId }, select: { id: true } });
    if (!item) throw new NotFoundError("Item not found");
    const entries = await academicDb().inventoryStockMovement.findMany({ where: { institutionId, itemId: id, kind: "ISSUE" }, include: { location: { select: { id: true, name: true } }, returns: { select: { quantity: true, kind: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const data = entries.map(({ returns, ...entry }) => {
      const returned = returns.filter(r => r.kind === "RETURN").reduce((sum, r) => sum.add(r.quantity), entry.quantity.mul(0));
      const damaged = returns.filter(r => r.kind === "ISSUE_DAMAGED").reduce((sum,r) => sum.add(r.quantity), entry.quantity.mul(0));
      const lost = returns.filter(r => r.kind === "ISSUE_LOST").reduce((sum,r) => sum.add(r.quantity), entry.quantity.mul(0));
      return { ...entry, returnedQuantity: returned.toString(), damagedQuantity: damaged.toString(), lostQuantity: lost.toString(), outstandingQuantity: entry.returnExpected ? entry.quantity.sub(returned).sub(damaged).sub(lost).toString() : "0" };
    });
    res.json({ success: true, data });
  } catch (err) { handleError(err, next); }
});

router.post("/items/:id/return-stock", movementUpload, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req), id = parse(idSchema, req.params.id), input = parse(returnSchema, req.body);
    await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id, institutionId } });
      if (!item) throw new NotFoundError("Item not found");
      if (item.type !== "CONSUMABLE" && !Number.isInteger(Number(input.quantity))) throw new BadRequestError("Equipment and assets must use whole quantities");
      const issue = await tx.inventoryStockMovement.findFirst({ where: { id: input.issueId, institutionId, itemId: id, kind: "ISSUE" }, include: { returns: { select: { quantity: true, kind: true } } } });
      if (!issue) throw new NotFoundError("Issue entry not found");
      if (!issue.returnExpected) throw new BadRequestError("Consumables are used up and cannot be returned through this flow");
      checkEventOrder(issue, input.recordedOn, input.recordedTime);
      const existing = await tx.inventoryStockMovement.findFirst({ where: { institutionId, requestId: input.requestId } });
      if (existing) {
        checkMovementFiles(req, existing.attachments);
        if (existing.kind !== "RETURN" || existing.itemId !== id || existing.issueId !== input.issueId || !existing.quantity.equals(input.quantity) || existing.recordedOn.toISOString().slice(0, 10) !== input.recordedOn || existing.notes !== input.notes || (existing.occurredAt?.toISOString() || null) !== (occurredAt(input.recordedOn, input.recordedTime)?.toISOString() || null)) throw new ConflictError("This return request was already used with different details");
        return;
      }
      const returned = issue.returns.reduce((sum, r) => sum.add(r.quantity), issue.quantity.mul(0));
      if (issue.quantity.sub(returned).lt(input.quantity)) throw new ConflictError("Return quantity exceeds the pending quantity. Refresh the issued items list.");
      const balance = await tx.inventoryStockBalance.findFirst({ where: { institutionId, itemId: id, locationId: issue.locationId } });
      if (!balance) throw new ConflictError("The original stock location is no longer available");
      if (balance.quantity.add(input.quantity).gt("1000000000")) throw new BadRequestError("Total stock at this location is too large");
      await tx.inventoryStockBalance.update({ where: { id: balance.id }, data: { quantity: balance.quantity.add(input.quantity) } });
      const attachments = await uploadMovementFiles(req, institutionId);
      await tx.inventoryStockMovement.create({ data: { attachments,
        institutionId, itemId: id, locationId: issue.locationId, kind: "RETURN", quantity: input.quantity,
        requestId: input.requestId, issueId: issue.id, issuedToType: issue.issuedToType, issuedToName: issue.issuedToName, issuedToLabel: issue.issuedToLabel,
        recordedOn: new Date(`${input.recordedOn}T00:00:00Z`), occurredAt: occurredAt(input.recordedOn, input.recordedTime), notes: input.notes, createdById: req.user!.userId,
      } });
    }, { timeout: 30000 });
    commitMovementFiles(req);
    const data = await academicDb().inventoryItem.findFirst({ where: { id, institutionId }, include });
    res.status(201).json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
export default router;
