import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors";
import type { Prisma } from "../../generated/prisma/client";

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
const event = (req: AuthRequest, action: string, reason = "") => ({ action, reason, actorId: req.user!.userId, actorRole: req.user!.role, at: new Date().toISOString() });

router.get("/purchase-requests", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = parse(z.coerce.number().int().min(1).max(100000).default(1), req.query.page);
    const where = { institutionId: school(req), source: { not: "TEACHER" }, ...(req.user!.role === "TEACHER" ? { source: "TEACHER", requestedById: req.user!.userId, createdById: req.user!.userId } : {}) };
    const [data, count] = await Promise.all([academicDb().inventoryPurchaseRequest.findMany({ where, include: { purchaseOrder: { select: { id: true, number: true, status: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 50, take: 50 }), academicDb().inventoryPurchaseRequest.count({ where })]);
    res.json({ success: true, data, count, page });
  } catch (err) { next(err); }
});
router.post("/purchase-requests", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const input = parse(createSchema, await requestBody(req)), institutionId = school(req);
    const existing = await academicDb().inventoryPurchaseRequest.findUnique({ where: { institutionId_requestId: { institutionId, requestId: input.requestId } } });
    if (existing) {
      if (existing.createdById !== req.user!.userId || existing.revision !== 1 || existing.requestedByName !== input.requestedByName || existing.department !== input.department || existing.reason !== input.reason || existing.requiredOn.toISOString().slice(0, 10) !== input.requiredOn || JSON.stringify((existing.lines as { name: string; unit: string; quantity: number }[]).map(line => [line.name, line.unit, line.quantity])) !== JSON.stringify(input.lines.map(line => [line.name, line.unit, line.quantity]))) throw new ConflictError("This request was already submitted with different details");
      res.status(201).json({ success: true, data: existing }); return;
    }
    const data = await academicDb().inventoryPurchaseRequest.create({ data: { ...input, institutionId, ...(req.user!.role === "TEACHER" ? { source: "TEACHER", requestedById: req.user!.userId } : {}), requiredOn: new Date(input.requiredOn + "T00:00:00Z"), createdById: req.user!.userId, events: [event(req, "SUBMITTED")] } });
    res.status(201).json({ success: true, data });
  } catch (err) { if ((err as { code?: string })?.code === "P2002") return next(new ConflictError("Request already submitted. Refresh the list.")); next(err); }
});
router.patch("/purchase-requests/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parse(idSchema, req.params.id), input = parse(editSchema, await requestBody(req)), institutionId = school(req);
    const data = await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseRequest" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const current = await tx.inventoryPurchaseRequest.findFirst({ where: { id, institutionId, source: { not: "TEACHER" } } });
      if (!current) throw new NotFoundError("Request not found");
      if (req.user!.role !== "ADMIN" && current.createdById !== req.user!.userId) throw new ForbiddenError("Only the request creator or admin can edit this request");
      if (!["PENDING", "CHANGES_REQUESTED"].includes(current.status) || current.revision !== input.revision) throw new ConflictError("Request changed or is no longer editable. Refresh the list.");
      const { revision, ...fields } = input;
      return tx.inventoryPurchaseRequest.update({ where: { id }, data: { ...fields, requiredOn: new Date(input.requiredOn + "T00:00:00Z"), status: "PENDING", revision: revision + 1, events: [...current.events as Prisma.JsonArray, event(req, "RESUBMITTED")] } });
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});
router.post("/purchase-requests/:id/review", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== "ADMIN") throw new ForbiddenError("Only an admin can review purchase requests");
    const id = parse(idSchema, req.params.id), input = parse(reviewSchema, req.body), institutionId = school(req);
    if (input.decision !== "APPROVED" && !input.reason) throw new BadRequestError("Enter a reason for rejection or requested changes");
    const data = await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "InventoryPurchaseRequest" WHERE "id" = ${id} AND "institutionId" = ${institutionId} FOR UPDATE`;
      const current = await tx.inventoryPurchaseRequest.findFirst({ where: { id, institutionId, source: { not: "TEACHER" } } });
      if (!current) throw new NotFoundError("Request not found");
      if (current.status !== "PENDING" || current.revision !== input.revision) throw new ConflictError("Request has changed or was already reviewed. Refresh the list.");
      return tx.inventoryPurchaseRequest.update({ where: { id }, data: { status: input.decision, revision: { increment: 1 }, events: [...current.events as Prisma.JsonArray, event(req, input.decision, input.reason)] } });
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});
export default router;
