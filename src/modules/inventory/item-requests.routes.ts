import { movementUpload, uploadMovementFiles, checkMovementFiles, commitMovementFiles } from "./movement-files";
import { movementTime, occurredAt } from "./movement-time";
import { requestProgress, purchaseLink, type RequestLine } from "./item-request-actions";
import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors";
import type { Prisma } from "../../generated/prisma/client";
import { createNotification } from "../../services/notification.service";

const router = Router();
const idSchema = z.string().uuid();
const details = z.object({
  requestedByName: z.string().trim().min(1).max(100), department: z.string().trim().max(100).default(""),
  reason: z.string().trim().min(1).max(1000), requiredOn: z.iso.date(),
  lines: z.array(z.object({ name: z.string().trim().min(1).max(150), unit: z.string().trim().min(1).max(40), quantity: z.number().int().min(1).max(1000000000) }).strict()).min(1).max(20),
}).strict();
const createSchema = details.extend({ requestId: idSchema });
const editSchema = details.extend({ revision: z.number().int().min(1) });
const reviewSchema = z.object({ revision: z.number().int().min(1), decision: z.enum(["APPROVED", "REJECTED", "CHANGES_REQUESTED"]), reason: z.string().trim().max(1000).default("") }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new BadRequestError(result.error.issues[0]?.message || "Invalid request details"); return result.data; }
function school(req: AuthRequest) { if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account"); return req.user.institutionId; }
// Teacher identity is authoritative; the client cannot impersonate another requester.
async function requestBody(req: AuthRequest) {
  if (req.user!.role !== "TEACHER") return req.body;
  const user = await prisma.user.findFirst({ where: { id: req.user!.userId, institutionId: school(req), role: "TEACHER" }, select: { name: true } });
  if (!user?.name) throw new ForbiddenError("Teacher account not found");
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new BadRequestError("Invalid request details");
  return { ...req.body, requestedByName: user.name };
}
// Item request notifications. A failed notification must never block the request action itself.
async function notifyUsers(institutionId: string, userIds: (string | null | undefined)[], title: string, message: string, sentById: string) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x && x !== sentById))];
  if (!ids.length) return;
  try { await createNotification({ title, message, tag: "INVENTORY", recipientType: "USER", sentById, recipients: ids.map(userId => ({ institutionId, userId })) }); } catch { /* non-blocking */ }
}
async function inventoryStaffIds(institutionId: string) {
  const [admins, subAdmins] = await Promise.all([
    prisma.user.findMany({ where: { institutionId, role: "ADMIN" }, select: { id: true } }),
    prisma.subAdmin.findMany({ where: { institutionId, permissions: { has: "INVENTORY" } }, select: { userId: true } }),
  ]);
  return [...admins.map(a => a.id), ...subAdmins.map(a => a.userId)];
}
const lineSummary = (lines: { name: string; quantity: number; unit: string }[]) => lines.length === 1 ? `${lines[0].name} (${lines[0].quantity} ${lines[0].unit})` : `${lines[0].name} and ${lines.length - 1} more item${lines.length > 2 ? "s" : ""}`;
const event = (req: AuthRequest, action: string, reason = "") => ({ action, reason, actorId: req.user!.userId, actorRole: req.user!.role, at: new Date().toISOString() });

// Names and units only (no stock numbers), so teachers can pick from the school's item list.
router.get("/item-catalogue", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const items = await academicDb().inventoryItem.findMany({ where: { institutionId: school(req) }, orderBy: { name: "asc" }, select: { id: true, name: true, unit: { select: { name: true, abbreviation: true } } } });
    res.json({ success: true, data: items.map(item => ({ id: item.id, name: item.name, unit: item.unit.name, unitAbbreviation: item.unit.abbreviation })) });
  } catch (err) { next(err); }
});
router.get("/item-requests", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = parse(z.coerce.number().int().min(1).max(100000).default(1), req.query.page);
    const where = { institutionId: school(req), source: "TEACHER", ...(req.user!.role === "TEACHER" ? { source: "TEACHER", requestedById: req.user!.userId, createdById: req.user!.userId } : {}) };
    const [data, count, pendingCount] = await Promise.all([academicDb().inventoryPurchaseRequest.findMany({ where, include: { purchaseOrder: { select: { id: true, number: true, status: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 50, take: 50 }), academicDb().inventoryPurchaseRequest.count({ where }), academicDb().inventoryPurchaseRequest.count({ where: { ...where, status: "PENDING" } })]);
    const movementIds = data.flatMap(request => (request.events as Prisma.JsonObject[]).filter(e => e.action === 'ITEM_ISSUED' && typeof e.movementId === 'string').map(e => e.movementId as string));
    const issuedMovements = movementIds.length ? await academicDb().inventoryStockMovement.findMany({ where: { institutionId: school(req), kind: 'ISSUE', id: { in: movementIds } }, include: { returns: true } }) : [];
    const movementMap = new Map(issuedMovements.map(m => [m.id, m]));
    const returnStatus = (request: typeof data[number]) => {
      if (request.status !== 'ISSUED') return request.status;
      const ids = (request.events as Prisma.JsonObject[]).filter(e => e.action === 'ITEM_ISSUED' && typeof e.movementId === 'string').map(e => e.movementId as string);
      const issues = ids.map(id => movementMap.get(id)).filter((m): m is NonNullable<typeof m> => !!m && m.returnExpected);
      if (!issues.length) return request.status;
      const pending = issues.some(m => Number(m.quantity) > m.returns.filter(r => ['RETURN', 'ISSUE_DAMAGED', 'ISSUE_LOST'].includes(r.kind)).reduce((sum, r) => sum + Number(r.quantity), 0));
      if (pending) return 'RETURN_PENDING';
      return issues.some(m => m.returns.some(r => ['ISSUE_DAMAGED', 'ISSUE_LOST'].includes(r.kind))) ? 'CLOSED' : 'RETURNED';
    };
    res.json({ success: true, data: data.map(request => ({ ...request, ledgerStatus: returnStatus(request), fulfilment: requestProgress(request.lines as RequestLine[], request.events), linkedPurchaseRequestId: purchaseLink(request.events) || null })), count, page, pendingCount });
  } catch (err) { next(err); }
});
router.post("/item-requests", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== "TEACHER") throw new ForbiddenError("Only a teacher can submit their item request");
    const input = parse(createSchema, await requestBody(req)), institutionId = school(req);
    const existing = await academicDb().inventoryPurchaseRequest.findUnique({ where: { institutionId_requestId: { institutionId, requestId: input.requestId } } });
    if (existing) {
      if (existing.createdById !== req.user!.userId || existing.revision !== 1 || existing.requestedByName !== input.requestedByName || existing.department !== input.department || existing.reason !== input.reason || existing.requiredOn.toISOString().slice(0, 10) !== input.requiredOn || JSON.stringify((existing.lines as { name: string; unit: string; quantity: number }[]).map(line => [line.name, line.unit, line.quantity])) !== JSON.stringify(input.lines.map(line => [line.name, line.unit, line.quantity]))) throw new ConflictError("This request was already submitted with different details");
      res.status(201).json({ success: true, data: existing }); return;
    }
    const data = await academicDb().inventoryPurchaseRequest.create({ data: { ...input, institutionId, ...(req.user!.role === "TEACHER" ? { source: "TEACHER", requestedById: req.user!.userId } : {}), requiredOn: new Date(input.requiredOn + "T00:00:00Z"), createdById: req.user!.userId, events: [event(req, "SUBMITTED")] } });
    await notifyUsers(institutionId, await inventoryStaffIds(institutionId), "New item request", `${input.requestedByName} requested ${lineSummary(input.lines)}.`, req.user!.userId);
    res.status(201).json({ success: true, data });
  } catch (err) { if ((err as { code?: string })?.code === "P2002") return next(new ConflictError("Request already submitted. Refresh the list.")); next(err); }
});
router.patch("/item-requests/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== "TEACHER") throw new ForbiddenError("Only the teacher can edit their item request");
    const id = parse(idSchema, req.params.id), input = parse(editSchema, await requestBody(req)), institutionId = school(req);
    const data = await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseRequest" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const current = await tx.inventoryPurchaseRequest.findFirst({ where: { id, institutionId, source: "TEACHER" } });
      if (!current) throw new NotFoundError("Request not found");
      if (req.user!.role !== "ADMIN" && current.createdById !== req.user!.userId) throw new ForbiddenError("Only the request creator or admin can edit this request");
      if (!["PENDING", "CHANGES_REQUESTED"].includes(current.status) || current.revision !== input.revision) throw new ConflictError("Request changed or is no longer editable. Refresh the list.");
      const { revision, ...fields } = input;
      return tx.inventoryPurchaseRequest.update({ where: { id }, data: { ...fields, requiredOn: new Date(input.requiredOn + "T00:00:00Z"), status: "PENDING", revision: revision + 1, events: [...current.events as Prisma.JsonArray, event(req, "RESUBMITTED")] } });
    });
    await notifyUsers(institutionId, await inventoryStaffIds(institutionId), "Item request resubmitted", `${input.requestedByName} resubmitted ${lineSummary(input.lines)}.`, req.user!.userId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});
router.post("/item-requests/:id/review", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    inventoryOperator(req);
    const id = parse(idSchema, req.params.id), input = parse(reviewSchema, req.body), institutionId = school(req);
    if (input.decision !== "APPROVED" && !input.reason) throw new BadRequestError("Enter a reason for rejection or requested changes");
    const data = await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseRequest" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const current = await tx.inventoryPurchaseRequest.findFirst({ where: { id, institutionId, source: "TEACHER" } });
      if (!current) throw new NotFoundError("Request not found");
      if (current.status !== "PENDING" || current.revision !== input.revision) throw new ConflictError("Request has changed or was already reviewed. Refresh the list.");
      return tx.inventoryPurchaseRequest.update({ where: { id }, data: { status: input.decision, revision: { increment: 1 }, events: [...current.events as Prisma.JsonArray, event(req, input.decision, input.reason)] } });
    });
    const outcome = { APPROVED: "approved", REJECTED: "rejected", CHANGES_REQUESTED: "sent back for changes" }[input.decision];
    await notifyUsers(institutionId, [data.requestedById], `Item request ${outcome}`, `Your request for ${lineSummary(data.lines as { name: string; quantity: number; unit: string }[])} was ${outcome}.${input.reason ? ` Reason: ${input.reason}` : ""}`, req.user!.userId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});
const issueRequestSchema = z.object({
  requestId: idSchema, revision: z.number().int().min(1), lineIndex: z.number().int().min(0).max(19),
  itemId: idSchema, locationId: idSchema, quantity: z.string().regex(/^\d{1,10}$/).refine(v => Number(v) >= 1 && Number(v) <= 1000000000, "Enter a whole-number quantity from 1 to 1,000,000,000"),
  recordedOn: z.iso.date(), recordedTime: movementTime, dueOn: z.iso.date().nullable().default(null), notes: z.string().trim().max(500).default(""),
}).strict().refine(v => !v.dueOn || v.dueOn >= v.recordedOn, "Return due date cannot be before the issue date");
const purchaseFromRequestSchema = z.object({ requestId: idSchema, revision: z.number().int().min(1) }).strict();
function inventoryOperator(req: AuthRequest) {
  if (!["ADMIN", "SUB_ADMIN"].includes(req.user!.role)) throw new ForbiddenError("Only school inventory staff can fulfil requests");
}
router.post("/item-requests/:id/issue", movementUpload, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    inventoryOperator(req);
    const id = parse(idSchema, req.params.id), institutionId = school(req), input = parse(issueRequestSchema, req.body);
    const issued: { requestedById?: string | null; text?: string } = {};
    await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseRequest" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const request = await tx.inventoryPurchaseRequest.findFirst({ where: { id, institutionId, source: "TEACHER" } });
      if (!request) throw new NotFoundError("Item request not found");
      const events = request.events as Prisma.JsonArray;
      const { revision, ...payload } = input;
      const fingerprint = JSON.stringify(payload);
      const previous = events.find(e => e && typeof e === "object" && !Array.isArray(e) && e.action === "ITEM_ISSUED" && e.requestId === input.requestId) as Prisma.JsonObject | undefined;
      if (previous) { const saved = await tx.inventoryStockMovement.findFirst({ where: { institutionId, requestId: input.requestId } }); checkMovementFiles(req, saved?.attachments); if (previous.fingerprint !== fingerprint) throw new ConflictError("This issue was already recorded with different details"); return; }
      if (!["APPROVED", "PARTIALLY_ISSUED"].includes(request.status) || request.revision !== revision) throw new ConflictError("Request changed or is not approved. Refresh the requests.");
      const progress = requestProgress(request.lines as RequestLine[], request.events), line = progress[input.lineIndex];
      if (!line || Number(input.quantity) > line.pending) throw new BadRequestError("Quantity exceeds the pending quantity for this request");
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${input.itemId} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const item = await tx.inventoryItem.findFirst({ where: { id: input.itemId, institutionId }, include: { unit: true } });
      if (!item) throw new NotFoundError("Inventory item not found");
      const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
      if (![item.unit.name, item.unit.abbreviation].filter(Boolean).some(value => norm(value!) === norm(line.unit))) throw new BadRequestError("Choose an item with the same unit as the request");
      if (item.type === "CONSUMABLE" && input.dueOn) throw new BadRequestError("Consumables do not have a return due date");
      const balance = await tx.inventoryStockBalance.findFirst({ where: { institutionId, itemId: input.itemId, locationId: input.locationId } });
      if (!balance || balance.quantity.lt(input.quantity)) throw new ConflictError("Not enough stock at this location. Refresh and check availability.");
      await tx.inventoryStockBalance.update({ where: { id: balance.id }, data: { quantity: balance.quantity.sub(input.quantity) } });
      const attachments = await uploadMovementFiles(req, institutionId);
      const movement = await tx.inventoryStockMovement.create({ data: { attachments, institutionId, itemId: item.id, locationId: input.locationId, kind: "ISSUE", quantity: input.quantity, requestId: input.requestId, issuedToType: "TEACHER", issuedToName: request.requestedByName, issuedToLabel: "", returnExpected: item.type !== "CONSUMABLE", dueOn: input.dueOn ? new Date(input.dueOn + "T00:00:00Z") : null, recordedOn: new Date(input.recordedOn + "T00:00:00Z"), occurredAt: occurredAt(input.recordedOn, input.recordedTime), notes: input.notes, createdById: req.user!.userId } });
      const updatedEvents = [...events, { ...event(req, "ITEM_ISSUED", input.notes), lineIndex: input.lineIndex, quantity: Number(input.quantity), itemId: input.itemId, locationId: input.locationId, movementId: movement.id, requestId: input.requestId, fingerprint }];
      const remaining = requestProgress(request.lines as RequestLine[], updatedEvents).some(line => line.pending > 0);
      await tx.inventoryPurchaseRequest.update({ where: { id }, data: { status: remaining ? "PARTIALLY_ISSUED" : "ISSUED", revision: { increment: 1 }, events: updatedEvents } });
      issued.requestedById = request.requestedById; issued.text = `${item.name} (${input.quantity} ${line.unit})`;
    }, { timeout: 30000 });
    commitMovementFiles(req);
    if (issued.text) await notifyUsers(institutionId, [issued.requestedById], "Item issued", `${issued.text} has been issued against your request.`, req.user!.userId);
    const data = await academicDb().inventoryItem.findFirst({ where: { id: input.itemId, institutionId }, include: { movements: { select: { kind: true, locationId: true } }, category: true, unit: true, balances: { include: { location: true } } } });
    res.status(201).json({ success: true, data });
  } catch (err) { if ((err as { code?: string })?.code === "P2002") return next(new ConflictError("Issue already recorded. Refresh before retrying.")); next(err); }
});
router.post("/item-requests/:id/create-purchase-request", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    inventoryOperator(req);
    const id = parse(idSchema, req.params.id), institutionId = school(req), input = parse(purchaseFromRequestSchema, req.body);
    const data = await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseRequest" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const request = await tx.inventoryPurchaseRequest.findFirst({ where: { id, institutionId, source: "TEACHER" }, include: { purchaseOrder: true } });
      if (!request) throw new NotFoundError("Item request not found");
      const linkedId = purchaseLink(request.events);
      if (linkedId) return tx.inventoryPurchaseRequest.findFirst({ where: { id: linkedId, institutionId, source: "ITEM_REQUEST_PURCHASE" } });
      if (request.purchaseOrder) throw new ConflictError("A purchase order already exists for this older request");
      if (!["APPROVED", "PARTIALLY_ISSUED"].includes(request.status) || request.revision !== input.revision) throw new ConflictError("Request changed or is not approved. Refresh the requests.");
      const lines = requestProgress(request.lines as RequestLine[], request.events).filter(line => line.pending > 0).map(line => ({ name: line.name, unit: line.unit, quantity: line.pending }));
      if (!lines.length) throw new ConflictError("All requested items have already been issued");
      const purchase = await tx.inventoryPurchaseRequest.create({ data: { institutionId, requestId: input.requestId, source: "ITEM_REQUEST_PURCHASE", requestedById: request.requestedById, requestedByName: request.requestedByName, department: request.department, reason: request.reason, requiredOn: request.requiredOn, lines, createdById: req.user!.userId, events: [{ ...event(req, "SUBMITTED"), itemRequestId: request.id }] } });
      await tx.inventoryPurchaseRequest.update({ where: { id }, data: { revision: { increment: 1 }, events: [...request.events as Prisma.JsonArray, { ...event(req, "PURCHASE_REQUEST_CREATED"), purchaseRequestId: purchase.id }] } });
      return purchase;
    });
    res.status(201).json({ success: true, data });
  } catch (err) { if ((err as { code?: string })?.code === "P2002") return next(new ConflictError("Purchase request already created. Refresh the requests.")); next(err); }
});

export default router;
