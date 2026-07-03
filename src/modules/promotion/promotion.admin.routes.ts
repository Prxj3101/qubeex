import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { getPromotionPreview, promoteStudents, undoPromotionBatch, listPromotionBatches } from "./promotion.controller";

const router = Router();
const ADMIN_ONLY = [authMiddleware(["ADMIN"]), institutionAccessMiddleware];

router.get("/divisions/:divisionId/preview", ...ADMIN_ONLY, getPromotionPreview);
router.post("/divisions/:divisionId", ...ADMIN_ONLY, promoteStudents);
router.post("/batches/:batchId/undo", ...ADMIN_ONLY, undoPromotionBatch);
router.get("/batches", ...ADMIN_ONLY, listPromotionBatches);

export default router;
