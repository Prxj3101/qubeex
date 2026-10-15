import ledgerCorrectionsRouter from "./ledger-corrections.routes";
import ledgerRouter from "./ledger.routes";
import itemRequestsRouter from "./item-requests.routes";
import setupOrderRouter from "./setup-order.routes";
import { withSetupOrder } from "./setup-order";
import purchaseOrdersRouter from "./purchase-orders.routes";
import purchaseRequestsRouter from "./purchase-requests.routes";
import issueResolutionRouter from "./issue-resolution.routes";
import inventoryAlertsRouter from "./inventory-alerts.routes";
import inventoryInsightsRouter from "./inventory-insights.routes";
import inventoryOverviewRouter from "./inventory-overview.routes";
import { ensureDefaultSetup } from "./inventory-defaults";
import supplierReturnRouter from "./supplier-return.routes";
import reportsRouter from "./reports.routes";
import adjustmentStockRouter from "./adjustment-stock.routes";
import transferStockRouter from "./transfer-stock.routes";
import issueStockRouter from "./issue-stock.routes";
import itemsRouter from './items.routes';
import suppliersRouter from './suppliers.routes';
import locationsRouter from './locations.routes';
import unitsRouter from './units.routes';
import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { requirePermission } from "../../middlewares/requirePermission.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";

const router = Router();
router.use(authMiddleware(["ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware, requirePermission("INVENTORY"));
const schema = z.object({
  name: z.string().trim().min(1).max(80).transform(value => value.replace(/\s+/g, " ")),
  description: z.string().trim().max(300).default(""),
}).strict();
const idSchema = z.string().uuid();
const institution = (req: AuthRequest) => {
  if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account");
  return req.user.institutionId;
};
const handleError = (err: unknown, next: NextFunction) => {
  const code = (err as { code?: string })?.code;
  if (code === "P2002") return next(new ConflictError("A category with this name already exists"));
  if (code === "P2003") return next(new ConflictError("This category is in use and cannot be deleted"));
  next(err);
};

router.get("/categories", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await ensureDefaultSetup("categories", institution(req));
    const data = await academicDb().inventoryCategory.findMany({ where: { institutionId: institution(req) }, orderBy: { name: "asc" }, select: { id: true, name: true, description: true, isDefault: true } });
    res.json({ success: true, ...await withSetupOrder("categories", institution(req), data) });
  } catch (err) { handleError(err, next); }
});
router.post("/categories", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const input = schema.parse(req.body);
    const data = await academicDb().inventoryCategory.create({ data: { ...input, nameKey: input.name.toLowerCase(), institutionId: institution(req) }, select: { id: true, name: true, description: true, isDefault: true } });
    res.status(201).json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
router.patch("/categories/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = idSchema.parse(req.params.id);
    const input = schema.parse(req.body);
    const result = await academicDb().inventoryCategory.updateMany({ where: { id, institutionId: institution(req) }, data: { ...input, nameKey: input.name.toLowerCase() } });
    if (!result.count) throw new NotFoundError("Category not found");
    const data = await academicDb().inventoryCategory.findFirst({ where: { id, institutionId: institution(req) }, select: { id: true, name: true, description: true, isDefault: true } });
    res.json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
router.delete("/categories/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = idSchema.parse(req.params.id);
    if (await academicDb().inventoryCategory.count({ where: { id, institutionId: institution(req), isDefault: true } })) throw new ConflictError("Built-in categories cannot be deleted. You can rename them instead.");
    const result = await academicDb().inventoryCategory.deleteMany({ where: { id, institutionId: institution(req), isDefault: false } });
    if (!result.count) throw new NotFoundError("Category not found");
    res.json({ success: true });
  } catch (err) { handleError(err, next); }
});
router.use(unitsRouter);
router.use(locationsRouter);
router.use(suppliersRouter);
router.use(itemsRouter);
router.use(issueStockRouter);
router.use(transferStockRouter);
router.use(adjustmentStockRouter);
router.use(reportsRouter);
router.use(supplierReturnRouter);
router.use(inventoryAlertsRouter);
router.use(inventoryInsightsRouter);
router.use(inventoryOverviewRouter);
router.use(issueResolutionRouter);
router.use(itemRequestsRouter);
router.use(ledgerRouter);
router.use(ledgerCorrectionsRouter);
router.use(purchaseRequestsRouter);
router.use(purchaseOrdersRouter);
router.use(setupOrderRouter);
export default router;
