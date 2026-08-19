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
