import { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/errors";
import { z } from "zod";

export const errorHandler = (
  err: Error,
  _req: Request,
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

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
};
