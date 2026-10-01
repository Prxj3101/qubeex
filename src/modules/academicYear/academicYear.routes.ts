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

// KNOWN LIMITATION — do not call this against a real institution's production
// data until Phase 2 of the academic-year feature ships. The endpoint itself is
// correct and race-safe, but rolling a live institution over today exposes gaps
// that have not been addressed yet:
//   - Fee structures are NOT cloned into the new year. Fee reads are scoped to
//     the current year, so every division will show no fee structure until an
//     admin re-enters them.
//   - StudentEnrollment semantics for promoted students (whether a promotion
//     batch records where the student was vs. where they are going, relative
//     to the rollover) are still being finalized, so enrollment history written
//     around a rollover may need correcting later.
<<<<<<< HEAD
//   - Existing teacher assignments are not yet year-filtered on read.
=======
//   - Teacher assignments are only partially year-filtered on read: the admin
//     campus reads getDivision and loadStandards (listStandards) now filter
//     DivisionAssignment by the selected academic year, but some other
//     assignment-reading code paths outside that scope may still be unfiltered.
>>>>>>> academic-year-phase2
// This is documentation only; the route is intentionally left fully functional.
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
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
    next(err);
  }
});

export default router;
