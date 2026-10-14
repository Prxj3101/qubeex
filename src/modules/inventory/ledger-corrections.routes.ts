import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";
import { movementUpload, fileFingerprints, uploadMovementFiles, commitMovementFiles } from "./movement-files";
import { movementTime, occurredAt, checkEventOrder } from "./movement-time";
import { requestProgress, RequestLine } from "./item-request-actions";
import type { Prisma } from "../../generated/prisma/client";
const router = Router();
const id = z.string().uuid();
const schema = z.object({ requestId: id, revision: z.number().int().min(0), reason: z.string().trim().min(1, 'Enter a correction reason').max(500), quantity: z.string().regex(/^\d{1,10}$/).refine(v => Number(v) >= 1 && Number(v) <= 1000000000, 'Enter a positive whole quantity'), locationId: id, recordedOn: z.iso.date(), recordedTime: movementTime, issuedToName: z.string().trim().min(1).max(120), notes: z.string().trim().max(500), dueOn: z.iso.date().nullable(), keepAttachments: z.array(z.string().url()).max(5) }).strict();
type Audit = { requestId: string; fingerprint: string; actorId: string; at: string; reason: string; before: Prisma.JsonObject; after: Prisma.JsonObject };
router.post('/ledger/movements/:id/correct', movementUpload, async (req: AuthRequest, res: Response, next: NextFunction) => {
 try {
  const institutionId = req.user?.institutionId;
  if (!institutionId) throw new BadRequestError('No institution associated with this account');
  const parsed = schema.safeParse(req.body), movementId = id.safeParse(req.params.id);
  if (!parsed.success || !movementId.success) throw new BadRequestError(parsed.success ? 'Invalid entry' : parsed.error.issues[0]?.message);
  const input = parsed.data, db = academicDb();
  const { revision, ...payload } = input;
  const fingerprint = JSON.stringify({ ...payload, files: fileFingerprints(req) });
  await db.$transaction(async tx => {
   // Match the request -> item lock order used by fulfilment to avoid deadlocks.
   const linked = await tx.inventoryPurchaseRequest.findFirst({ where: { institutionId, source: 'TEACHER', events: { array_contains: [{ action: 'ITEM_ISSUED', movementId: movementId.data }] } } });
   if (linked) await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseRequest" WHERE "id" = ${linked.id} AND "institutionId" = ${institutionId} FOR UPDATE`;
   const found = await tx.inventoryStockMovement.findFirst({ where: { id: movementId.data, institutionId } });
   if (!found || !['ISSUE', 'RETURN', 'ISSUE_DAMAGED', 'ISSUE_LOST'].includes(found.kind)) throw new NotFoundError('Ledger entry not found');
   await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${found.itemId} AND "institutionId" = ${institutionId} FOR UPDATE`;
   const movement = await tx.inventoryStockMovement.findFirst({ where: { id: found.id, institutionId }, include: { returns: true, location: true } });
   if (!movement) throw new NotFoundError('Ledger entry not found');
   if (['ISSUE_DAMAGED', 'ISSUE_LOST'].includes(movement.kind) && !input.notes.trim()) throw new BadRequestError('Keep a reason for damage or loss');
   const audit = movement.corrections as unknown as Audit[];
   const previous = audit.find(a => a.requestId === input.requestId);
   if (previous) { if (previous.fingerprint !== fingerprint) throw new ConflictError('This correction was already recorded with different details'); return; }
   if (audit.length !== revision) throw new ConflictError('Entry has changed. Reopen it before editing.');
   const location = await tx.inventoryLocation.findFirst({ where: { id: input.locationId, institutionId } });
   if (!location) throw new BadRequestError('Select a school location');
   const actual = occurredAt(input.recordedOn, input.recordedTime);
   const issue = movement.kind === 'ISSUE' ? movement : await tx.inventoryStockMovement.findFirst({ where: { id: movement.issueId!, institutionId, kind: 'ISSUE' }, include: { returns: true } });
   if (!issue) throw new NotFoundError('Original issue not found');
   if (movement.kind !== 'ISSUE') {
    if (input.locationId !== movement.locationId || input.issuedToName !== issue.issuedToName) throw new BadRequestError('Return location and recipient must match the original issue');
    checkEventOrder(issue, input.recordedOn, input.recordedTime);
    const other = issue.returns.filter(r => r.id !== movement.id).reduce((n, r) => n + Number(r.quantity), 0);
    if (other + Number(input.quantity) > Number(issue.quantity)) throw new BadRequestError('Corrected quantity exceeds the issued quantity');
   } else {
    const closed = issue.returns.reduce((n, r) => n + Number(r.quantity), 0);
    if (Number(input.quantity) < closed) throw new BadRequestError('Quantity cannot be less than the quantity already returned, damaged or lost');
    if (issue.returns.length && input.locationId !== movement.locationId) throw new BadRequestError('Location cannot change after a return, damage or loss has been recorded');
    if (issue.returns.some(r => input.recordedOn > r.recordedOn.toISOString().slice(0, 10) || (actual && r.occurredAt && actual > r.occurredAt))) throw new BadRequestError('Issue date and time cannot be after an existing return, damage or loss');
    if (!issue.returnExpected && input.dueOn) throw new BadRequestError('Consumables do not have a return due date');
    if (input.dueOn && input.dueOn < input.recordedOn) throw new BadRequestError('Due date cannot be before issue date');
   }
   const request = linked ? await tx.inventoryPurchaseRequest.findFirst({ where: { id: linked.id, institutionId } }) : null;
   let requestEvents: Prisma.JsonArray | undefined;
   if (request) {
    if (input.issuedToName !== request.requestedByName) throw new BadRequestError('Recipient must match the teacher request');
    const events = request.events as Prisma.JsonObject[];
    const issuedEvent = events.find(e => e.action === 'ITEM_ISSUED' && e.movementId === movement.id);
    if (!issuedEvent) throw new ConflictError('Request issue link changed');
    const index = Number(issuedEvent.lineIndex), line = (request.lines as RequestLine[])[index];
    const other = events.filter(e => e.action === 'ITEM_ISSUED' && e.lineIndex === index && e.movementId !== movement.id).reduce((n, e) => n + Number(e.quantity), 0);
    if (!line || other + Number(input.quantity) > line.quantity) throw new BadRequestError('Corrected issue quantity exceeds the teacher request');
    requestEvents = events.map(e => e === issuedEvent ? { ...e, quantity: Number(input.quantity) } : e);
   }
   // Reverse the original stock effect, then apply the corrected effect atomically.
   const effects = new Map<string, number>();
   const add = (locationId: string, delta: number) => effects.set(locationId, (effects.get(locationId) || 0) + delta);
   if (movement.kind === 'ISSUE') { add(movement.locationId, Number(movement.quantity)); add(input.locationId, -Number(input.quantity)); }
   if (movement.kind === 'RETURN') add(movement.locationId, Number(input.quantity) - Number(movement.quantity));
   for (const [locationId, delta] of effects) {
    const balance = await tx.inventoryStockBalance.findFirst({ where: { institutionId, itemId: movement.itemId, locationId } });
    const updated = Number(balance?.quantity || 0) + delta;
    if (updated < 0 || updated > 1000000000) throw new ConflictError('Not enough available stock for this correction');
    if (balance) await tx.inventoryStockBalance.update({ where: { id: balance.id }, data: { quantity: String(updated) } });
    else if (updated > 0) await tx.inventoryStockBalance.create({ data: { institutionId, itemId: movement.itemId, locationId, quantity: String(updated) } });
   }
   const currentFiles = movement.attachments as Prisma.JsonObject[];
   if (input.keepAttachments.some(url => !currentFiles.some(f => f.url === url))) throw new BadRequestError('Attachment does not belong to this entry');
   const attachments = [...currentFiles.filter(f => input.keepAttachments.includes(String(f.url))), ...await uploadMovementFiles(req, institutionId)];
   if (attachments.length > 5 || attachments.reduce((n, f) => n + Number(f.size || 0), 0) > 25 * 1024 * 1024) throw new BadRequestError('Keep up to 5 attachments, 25 MB total');
   const snapshot = (m: { quantity: unknown; locationId: string; recordedOn: Date; occurredAt: Date | null; issuedToName: string; notes: string; dueOn: Date | null; attachments: unknown; location?: { name: string } }): Prisma.JsonObject => ({ quantity: String(m.quantity), locationName: m.location?.name || '', locationId: m.locationId, recordedOn: m.recordedOn.toISOString(), occurredAt: m.occurredAt?.toISOString() || null, issuedToName: m.issuedToName, notes: m.notes, dueOn: m.dueOn?.toISOString() || null, attachments: m.attachments as Prisma.JsonArray });
   const updated = { quantity: input.quantity, locationId: input.locationId, recordedOn: new Date(input.recordedOn + 'T00:00:00Z'), occurredAt: actual, issuedToName: input.issuedToName, notes: input.notes, dueOn: movement.kind === 'ISSUE' && input.dueOn ? new Date(input.dueOn + 'T00:00:00Z') : movement.kind === 'ISSUE' ? null : movement.dueOn, attachments };
   const correction = { requestId: input.requestId, fingerprint, actorId: req.user!.userId, at: new Date().toISOString(), reason: input.reason, before: snapshot(movement), after: snapshot({ ...updated, location }) };
   await tx.inventoryStockMovement.update({ where: { id: movement.id }, data: { ...updated, corrections: [...movement.corrections as Prisma.JsonArray, correction] } });
   if (movement.kind === 'ISSUE') await tx.inventoryStockMovement.updateMany({ where: { institutionId, issueId: movement.id }, data: { issuedToName: input.issuedToName } });
   if (request && requestEvents) await tx.inventoryPurchaseRequest.update({ where: { id: request.id }, data: { events: [...requestEvents, { action: 'ITEM_CORRECTED', movementId: movement.id, at: correction.at, actorId: correction.actorId, reason: input.reason }], revision: { increment: 1 }, status: requestProgress(request.lines as RequestLine[], requestEvents).some(l => l.pending > 0) ? 'PARTIALLY_ISSUED' : 'ISSUED' } });
  }, { timeout: 30000 });
  commitMovementFiles(req); res.json({ success: true });
 } catch (err) { next(err); }
});
export default router;
