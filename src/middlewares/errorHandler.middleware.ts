import { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/errors";
import { z } from "zod";
import { logAudit } from "../services/audit.service";

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
    });
    return;
  }

  // Academic-year utilities (resolveRequestedAcademicYear, assertAcademicYearAccess)
  // throw plain `{ status, message }` objects rather than AppError instances —
  // handle that shape the same way so year-aware routes return the intended
  // 403/404 instead of falling through to a generic 500.
  if (
    err &&
    typeof err === "object" &&
    !(err instanceof Error) &&
    typeof (err as { status?: unknown }).status === "number"
  ) {
    const { status, message } = err as { status: number; message?: string };
    res.status(status).json({
      success: false,
      error: message ?? "Request failed",
    });
    return;
  }

  if (err instanceof z.ZodError) {
    const fieldErrors = err.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));

    res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: fieldErrors,
    });
    return;
  }

  console.error("Unhandled error:", err);

  // Feeds the superadmin System Health page's "Recent Errors" list and error-rate
  // chart — only genuine unexpected 5xx failures land here, not routine 4xx AppErrors.
  logAudit("UNHANDLED_ERROR", {
    category: "SYSTEM",
    severity: "CRITICAL",
    details: err.message || "Unhandled server error",
    metadata: { endpoint: `${req.method} ${req.originalUrl}` },
  });

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
};
