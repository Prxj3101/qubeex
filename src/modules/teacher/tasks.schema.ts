// src/modules/teacher/tasks.schema.ts
import { z } from "zod";

export const generateQuestionsSchema = z.object({
  divisionId: z.string().min(1),
  prompt: z.string().max(500).trim().optional(),
  more: z.boolean().optional().default(false),
});

export const editQuestionSchema = z.object({
  question: z.string().min(1).max(2000).trim(),
  options: z.array(z.string().min(1).max(500).trim()).length(4).optional(),
  answer: z.string().min(1).max(1000).trim(),
});

export const createModuleSchema = z.object({
  divisionId: z.string().min(1),
  name: z.string().min(1).max(200).trim(),
  description: z.string().max(500).trim().optional(),
});

export const editModuleSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(500).trim().optional(),
}).refine(d => d.name !== undefined || d.description !== undefined, {
  message: "At least one field required",
});

export const assignQuestionSchema = z.object({
  questionId: z.string().uuid(),
});
