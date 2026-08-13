import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth.middleware";
import { getAcademicClient } from "../services/tenantDb.service";
import { runWithAcademicClient } from "../utils/academicContext";

/**
 * Resolves the academic client for the authenticated institution and runs the rest
 * of the request inside an AsyncLocalStorage scope so `academicDb()` returns it.
 *
 * Mount AFTER auth on academic route groups (teacher/student/admin/campus/staffroom).
 * Requests without an institution (e.g. superadmin) pass through with no context.
 *
 * NOTE: not yet mounted in app.ts — activation happens with the Phase 2b query-site
 * migration, once academic code actually reads `academicDb()`.
 */
export const academicRoutingMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const institutionId = req.user?.institutionId;
  if (!institutionId) {
    next();
    return;
  }
  try {
    const client = await getAcademicClient(institutionId);
    runWithAcademicClient(client, () => next());
  } catch (err) {
    if ((err as { code?: string })?.code === "INSTITUTION_DB_UNAVAILABLE") {
      res.status(503).json({
        success: false,
        code: "INSTITUTION_DB_UNAVAILABLE",
        message: "Your institution's database is currently unavailable. Please contact support.",
      });
      return;
    }
    next(err);
  }
};
