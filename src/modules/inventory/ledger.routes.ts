import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { BadRequestError } from "../../utils/errors";
import { requestProgress, purchaseLink, RequestLine } from "./item-request-actions";
const router = Router();
router.get("/ledger", async (req: AuthRequest, res: Response, next: NextFunction) => {
 try {
  const institutionId = req.user?.institutionId;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  const parsed = z.coerce.number().int().min(1).max(100000).default(1).safeParse(req.query.page);
  if (!parsed.success) throw new BadRequestError("Invalid page");
  // A single day (date) or a range (from / to). Leave all empty to see every date.
  const dateInput = z.object({ date: z.iso.date().optional(), from: z.iso.date().optional(), to: z.iso.date().optional() }).safeParse(req.query);
  if (!dateInput.success) throw new BadRequestError("Invalid ledger date");
  const from = dateInput.data.from || dateInput.data.date || '0001-01-01', to = dateInput.data.to || dateInput.data.date || '9999-12-31';
  if (from > to) throw new BadRequestError("The start date cannot be after the end date");
  const page = parsed.data, db = academicDb();
  // Request-linked issues remain inside their request, rather than appearing twice.
  // "linked" is built once, so each direct issue is checked with a hash lookup instead of re-reading every request.
  const rows = await db.$queryRaw<{ id: string | null; source: string | null; total: bigint }[]>`
   WITH linked AS (
    SELECT DISTINCT r."id" AS rid, e->>'movementId' AS mid
    FROM "InventoryPurchaseRequest" r, jsonb_array_elements(r."events") e
    WHERE r."institutionId" = ${institutionId} AND r."source" = 'TEACHER'
    AND e->>'action' = 'ITEM_ISSUED' AND e->>'movementId' IS NOT NULL
   ), ledger AS (
    SELECT r."id", 'REQUEST' AS source, r."createdAt" FROM "InventoryPurchaseRequest" r
    WHERE r."institutionId" = ${institutionId} AND r."source" = 'TEACHER'
    AND ((r."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date BETWEEN CAST(${from} AS date) AND CAST(${to} AS date)
      OR EXISTS (SELECT 1 FROM linked l JOIN "InventoryStockMovement" i ON i."id" = l.mid
        WHERE l.rid = r."id" AND i."institutionId" = ${institutionId}
        AND (i."recordedOn" BETWEEN CAST(${from} AS date) AND CAST(${to} AS date) OR EXISTS
          (SELECT 1 FROM "InventoryStockMovement" t WHERE t."institutionId" = ${institutionId}
           AND t."issueId" = i."id" AND t."recordedOn" BETWEEN CAST(${from} AS date) AND CAST(${to} AS date)))))
    UNION ALL
    SELECT m."id", 'DIRECT' AS source, m."createdAt" FROM "InventoryStockMovement" m
    WHERE m."institutionId" = ${institutionId} AND m."kind" = 'ISSUE'
    AND (m."recordedOn" BETWEEN CAST(${from} AS date) AND CAST(${to} AS date)
      OR EXISTS (SELECT 1 FROM "InventoryStockMovement" t WHERE t."institutionId" = ${institutionId}
        AND t."issueId" = m."id" AND t."recordedOn" BETWEEN CAST(${from} AS date) AND CAST(${to} AS date)))
    AND m."id" NOT IN (SELECT mid FROM linked)
   ) , paged AS (SELECT * FROM ledger ORDER BY "createdAt" DESC, "id" DESC LIMIT 50 OFFSET ${(page - 1) * 50})
   SELECT paged."id", paged.source, (SELECT COUNT(*) FROM ledger) AS total
   FROM (SELECT 1) anchor LEFT JOIN paged ON TRUE ORDER BY paged."createdAt" DESC, paged."id" DESC`;
  const records = rows.filter((row): row is { id: string; source: string; total: bigint } => !!row.id && !!row.source);
  const requests = await db.inventoryPurchaseRequest.findMany({ where: { institutionId, source: "TEACHER", id: { in: records.filter(r => r.source === 'REQUEST').map(r => r.id) } }, include: { purchaseOrder: { select: { number: true } } } });
  const linkedIds = requests.flatMap(r => (r.events as { movementId?: string }[]).map(e => e.movementId).filter((id): id is string => !!id));
  const movements = await db.inventoryStockMovement.findMany({ where: { institutionId, kind: "ISSUE", id: { in: [...linkedIds, ...records.filter(r => r.source === 'DIRECT').map(r => r.id)] } }, include: { item: { include: { unit: true, category: true, balances: { include: { location: true } } } }, location: true, returns: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
  const actorIds = [...new Set(movements.flatMap(m => [m.createdById, ...m.returns.map(r => r.createdById), ...(m.corrections as { actorId: string }[]).map(c => c.actorId), ...m.returns.flatMap(r => (r.corrections as { actorId: string }[]).map(c => c.actorId))]))];
  const actors = await prisma.user.findMany({ where: { institutionId, id: { in: actorIds } }, select: { id: true, name: true } });
  const names = new Map(actors.map(a => [a.id, a.name]));
  const issues = movements.map(m => {
   const sum = (kind: string) => m.returns.filter(r => r.kind === kind).reduce((n, r) => n + Number(r.quantity), 0);
   const returned = sum('RETURN'), damaged = sum('ISSUE_DAMAGED'), lost = sum('ISSUE_LOST');
   const corrections = (value: unknown) => (value as { actorId: string }[]).map(c => ({ ...c, actorName: names.get(c.actorId) || 'School staff' }));
   return { ...m, corrections: corrections(m.corrections), issuedByName: names.get(m.createdById) || 'School staff', returnedQuantity: returned, damagedQuantity: damaged, lostQuantity: lost, outstandingQuantity: m.returnExpected ? Math.max(0, Number(m.quantity) - returned - damaged - lost) : 0, returns: m.returns.map(r => ({ ...r, corrections: corrections(r.corrections), recordedByName: names.get(r.createdById) || 'School staff' })) };
  });
  const data = records.map(row => {
   if (row.source === 'REQUEST') {
    const r = requests.find(r => r.id === row.id)!;
    const ids = new Set((r.events as { movementId?: string }[]).map(e => e.movementId));
    const requestIssues = issues.filter(i => ids.has(i.id));
    const returnable = requestIssues.filter(i => i.returnExpected);
    const ledgerStatus = r.status === 'ISSUED' && returnable.length ? returnable.some(i => i.outstandingQuantity > 0) ? 'RETURN_PENDING' : returnable.some(damagedOrLost) ? 'CLOSED' : 'RETURNED' : r.status;
    return { ...r, ledgerStatus, ledgerSource: 'REQUEST', fulfilment: requestProgress(r.lines as RequestLine[], r.events), linkedPurchaseRequestId: purchaseLink(r.events) || null, issues: requestIssues };
   }
   const m = issues.find(i => i.id === row.id)!;
   return { id: m.id, ledgerSource: 'DIRECT', revision: 0, requestedByName: m.issuedToName, department: m.issuedToLabel || m.issuedToType, requiredOn: m.recordedOn, createdAt: m.createdAt, reason: m.notes, status: !m.returnExpected ? 'ISSUED' : m.outstandingQuantity > 0 ? 'RETURN_PENDING' : damagedOrLost(m) ? 'CLOSED' : 'RETURNED', fulfilment: [{ name: m.item.name, unit: m.item.unit.abbreviation || m.item.unit.name, quantity: Number(m.quantity), issued: Number(m.quantity), pending: 0 }], events: [], issues: [m] };
  });
  const pendingCount = await db.inventoryPurchaseRequest.count({ where: { institutionId, source: 'TEACHER', status: 'PENDING' } });
  res.json({ success: true, data, count: Number(rows[0]?.total || 0), page, pendingCount });
 } catch (err) { next(err); }
});
function damagedOrLost(m: { damagedQuantity: number; lostQuantity: number }) { return m.damagedQuantity + m.lostQuantity > 0; }
export default router;
