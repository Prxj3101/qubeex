// src/services/remark.schema.ts
import { z } from "zod";

const remarkAttachmentSchema = z.object({
  url: z.string().url(),
  name: z.string().max(200),
  type: z.string().max(50),
});
export type RemarkAttachment = z.infer<typeof remarkAttachmentSchema>;

export const createRemarkSchema = z.object({
  // Which card section this report lands in — chosen directly by the
  // reporter now, no longer inferred from severity.
  type: z.enum(["YELLOW", "RED"]).default("YELLOW"),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  category: z.string().min(1).max(100).trim(),
  title: z.string().min(1).max(200).trim(),
  detail: z.string().min(1).max(2000).trim(),
  subject: z.string().max(100).trim().optional(),
  actionTaken: z.string().max(1000).trim().optional(),
  // Multiple attachments — images, files, or videos — instead of just one.
  attachments: z.array(remarkAttachmentSchema).max(10).optional(),
});

export type CreateRemarkInput = z.infer<typeof createRemarkSchema>;

export const reviewRemarkSchema = z.object({
  status: z.enum(["UNDER_REVIEW", "RESOLVED", "REJECTED"]),
  reviewRemark: z.string().max(1000).trim().optional(),
});

export type ReviewRemarkInput = z.infer<typeof reviewRemarkSchema>;
