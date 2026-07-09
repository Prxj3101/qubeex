import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { submitOutcomesSchema } from "./promotion.schema";
import { getPromotionPreview, applyPromotionOutcomes, undoPromotionBatch, listPromotionBatches } from "./promotion.service";

const router = Router();
const A = [authMiddleware(["ADMIN"]), institutionAccessMiddleware];

router.get("/divisions/:divisionId/preview", ...A, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const divisionId = req.params.divisionId as string;

    const data = await getPromotionPreview(divisionId, institutionId);
    if (!data) { res.status(404).json({ success: false, error: "Division not found" }); return; }
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post("/divisions/:divisionId", ...A, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const divisionId = req.params.divisionId as string;

    const input = submitOutcomesSchema.parse(req.body);
    const result = await applyPromotionOutcomes({ divisionId, institutionId, userId, actorRole: "ADMIN", input });
    res.json({ success: true, data: { batchId: result.batchId }, warning: result.warning });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
});

router.post("/batches/:batchId/undo", ...A, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const batchId = req.params.batchId as string;
    await undoPromotionBatch(batchId, institutionId);
    res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
});

router.get("/batches", ...A, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const divisionIdFilter = req.query.divisionId as string | undefined;
    const data = await listPromotionBatches(institutionId, divisionIdFilter ? [divisionIdFilter] : undefined);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;
