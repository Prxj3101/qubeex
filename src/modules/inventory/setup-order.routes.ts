import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { Prisma } from "../../generated/prisma/client";
import { BadRequestError, ConflictError } from "../../utils/errors";

const router = Router();
const kinds = z.enum(["categories", "units", "locations", "suppliers"]);
const schema = z.object({ ids: z.array(z.string().uuid()).min(1).max(5000).refine(ids => new Set(ids).size === ids.length, "Each record must appear once"), revision: z.number().int().min(0).max(2147483646) }).strict();
const tables = { categories: '"InventoryCategory"', units: '"InventoryUnit"', locations: '"InventoryLocation"', suppliers: '"InventorySupplier"' };
router.post("/setup-order/:kind", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = req.user?.institutionId;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const kindResult = kinds.safeParse(req.params.kind), inputResult = schema.safeParse(req.body);
    if (!kindResult.success || !inputResult.success) throw new BadRequestError(inputResult.error?.issues[0]?.message || "Invalid setup list");
    const kind = kindResult.data, input = inputResult.data;
    const saved = await academicDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`inventory-setup:${institutionId}:${kind}`}))::text`;
      const current = await tx.inventorySetupOrder.findUnique({ where: { institutionId_kind: { institutionId, kind } } });
      if ((current?.revision || 0) !== input.revision) throw new ConflictError("List order changed. Refresh and try again.");
      const records = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM ${Prisma.raw(tables[kind])} WHERE "institutionId" = ${institutionId} ORDER BY "id" FOR UPDATE`);
      const allowed = new Set(records.map(record => record.id));
      if (records.length !== input.ids.length || input.ids.some(id => !allowed.has(id))) throw new ConflictError("List changed. Refresh before arranging it again.");
      return tx.inventorySetupOrder.upsert({ where: { institutionId_kind: { institutionId, kind } }, create: { institutionId, kind, ids: input.ids, revision: 1 }, update: { ids: input.ids, revision: { increment: 1 } } });
    });
    res.json({ success: true, orderRevision: saved.revision });
  } catch (err) { next(err); }
});
export default router;
