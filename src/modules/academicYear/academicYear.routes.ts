import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { startNewAcademicYearSchema } from "./academicYear.schema";
import { listAcademicYears, startNewAcademicYear } from "./academicYear.service";

const router = Router();
const ANY = [authMiddleware([]), institutionAccessMiddleware, academicRoutingMiddleware];
const ADMIN = [authMiddleware(["ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware];

router.get("/academic-years", ...ANY, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const data = await listAcademicYears(institutionId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/academic-years", ...ADMIN, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const input = startNewAcademicYearSchema.parse(req.body);
    const data = await startNewAcademicYear(institutionId, input);
    res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ success: false, error: "Invalid input" });
      return;
    }
    next(err);
  }
});

export default router;
