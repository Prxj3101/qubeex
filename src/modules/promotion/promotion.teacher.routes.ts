import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { getPromotionPreview, promoteStudents, undoPromotionBatch } from "./promotion.controller";

const router = Router();
const TEACHER_ONLY = [authMiddleware(["TEACHER"]), institutionAccessMiddleware];

router.get("/divisions/:divisionId/preview", ...TEACHER_ONLY, getPromotionPreview);
router.post("/divisions/:divisionId", ...TEACHER_ONLY, promoteStudents);
router.post("/batches/:batchId/undo", ...TEACHER_ONLY, undoPromotionBatch);

export default router;
