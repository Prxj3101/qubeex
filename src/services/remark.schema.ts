// src/services/remark.schema.ts
import { z } from "zod";

export const createRemarkSchema = z.object({
  type: z.enum(["yellow", "red"]),
  category: z.string().min(1).max(100).trim(),
  title: z.string().min(1).max(200).trim(),
  detail: z.string().min(1).max(2000).trim(),
  subject: z.string().max(100).trim().optional(),
  actionTaken: z.string().max(1000).trim().optional(),
});

export type CreateRemarkInput = z.infer<typeof createRemarkSchema>;
