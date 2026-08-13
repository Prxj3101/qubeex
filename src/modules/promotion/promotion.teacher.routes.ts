import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { academicDb } from "../../utils/academicContext";
import { submitOutcomesSchema } from "./promotion.schema";
import { getPromotionPreview, applyPromotionOutcomes, undoPromotionBatch, listPromotionBatches } from "./promotion.service";

const router = Router();
const T = [authMiddleware(["TEACHER"]), institutionAccessMiddleware, academicRoutingMiddleware];

async function assertClassTeacher(userId: string, institutionId: string, divisionId: string): Promise<string> {
  const teacher = await academicDb().teacher.findFirst({ where: { userId, institutionId }, select: { id: true } });
  if (!teacher) throw { status: 404, message: "Teacher profile not found" };
  const assignment = await academicDb().divisionAssignment.findFirst({
    where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
    select: { id: true },
  });
  if (!assignment) throw { status: 403, message: "Only the class teacher can perform this action" };
  return teacher.id;
}

async function assertBatchOwnedByClassTeacher(userId: string, institutionId: string, batchId: string): Promise<void> {
  const batch = await academicDb().promotionBatch.findFirst({ where: { id: batchId, institutionId }, select: { fromDivisionId: true } });
  if (!batch) throw { status: 404, message: "Promotion batch not found" };
  await assertClassTeacher(userId, institutionId, batch.fromDivisionId);
}

router.get("/divisions/:divisionId/preview", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const divisionId = req.params.divisionId as string;
    await assertClassTeacher(userId, institutionId, divisionId);

    const data = await getPromotionPreview(divisionId, institutionId);
    if (!data) { res.status(404).json({ success: false, error: "Division not found" }); return; }
    res.json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
});

router.post("/divisions/:divisionId", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const divisionId = req.params.divisionId as string;
    await assertClassTeacher(userId, institutionId, divisionId);

    const input = submitOutcomesSchema.parse(req.body);
    const result = await applyPromotionOutcomes({ divisionId, institutionId, userId, actorRole: "TEACHER", input });
    res.json({ success: true, data: { batchId: result.batchId }, warning: result.warning });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
});

router.post("/batches/:batchId/undo", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const batchId = req.params.batchId as string;
    await assertBatchOwnedByClassTeacher(userId, institutionId, batchId);
    await undoPromotionBatch(batchId, institutionId);
    res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
});

router.get("/batches", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }

    const teacher = await academicDb().teacher.findFirst({ where: { userId, institutionId }, select: { id: true } });
    if (!teacher) { res.status(404).json({ success: false, error: "Teacher profile not found" }); return; }

    const ownedDivisions = await academicDb().divisionAssignment.findMany({
      where: { teacherId: teacher.id, institutionId, subjectId: null },
      select: { divisionId: true },
    });
    const ownedDivisionIds = ownedDivisions.map((d) => d.divisionId);

    const divisionIdFilter = req.query.divisionId as string | undefined;
    let scopedIds = ownedDivisionIds;
    if (divisionIdFilter) {
      if (!ownedDivisionIds.includes(divisionIdFilter)) { res.status(403).json({ success: false, error: "Not the class teacher of this division" }); return; }
      scopedIds = [divisionIdFilter];
    }

    const data = await listPromotionBatches(institutionId, scopedIds);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;
