// src/services/remark.schema.ts
import { z } from "zod";

export const createRemarkSchema = z.object({
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  category: z.string().min(1).max(100).trim(),
  title: z.string().min(1).max(200).trim(),
  detail: z.string().min(1).max(2000).trim(),
  subject: z.string().max(100).trim().optional(),
  actionTaken: z.string().max(1000).trim().optional(),
  attachmentUrl: z.string().url().optional(),
  attachmentType: z.string().max(50).optional(),
  attachmentName: z.string().max(200).optional(),
});

export type CreateRemarkInput = z.infer<typeof createRemarkSchema>;

export const reviewRemarkSchema = z.object({
  status: z.enum(["UNDER_REVIEW", "RESOLVED", "REJECTED"]),
  reviewRemark: z.string().max(1000).trim().optional(),
});

export type ReviewRemarkInput = z.infer<typeof reviewRemarkSchema>;
