// src/modules/teacher/tasks.schema.ts
import { z } from "zod";

export const generateQuestionsSchema = z.object({
  divisionId: z.string().min(1),
  prompt: z.string().max(500).trim().optional(),
  more: z.boolean().optional().default(false),
});

export const editQuestionSchema = z.object({
  question: z.string().min(1).max(2000).trim(),
  questionTemplate: z.string().max(2000).trim().optional(),
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

export const createTestSchema = z.object({
  divisionId: z.string().min(1),
  title: z.string().min(1).max(200).trim(),
  description: z.string().max(1000).trim().optional(),
  durationMinutes: z.number().int().min(5).max(300).optional(),
  marksPerQuestion: z.number().int().min(1).max(10).optional(),
  numberOfQuestions: z.number().int().min(1).max(100),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  validUntil: z.string().datetime().optional().nullable(),
});

export const updateTestSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(1000).trim().optional().nullable(),
  durationMinutes: z.number().int().min(5).max(300).optional(),
  marksPerQuestion: z.number().int().min(1).max(10).optional(),
  numberOfQuestions: z.number().int().min(1).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  validUntil: z.string().datetime().optional().nullable(),
  status: z.enum(["DRAFT", "ACTIVE", "COMPLETED"]).optional(),
});

export const addTestQuestionSchema = z.object({
  questionId: z.string().uuid(),
  isCompulsory: z.boolean().optional(),
});

export const startQuizSchema = z.object({
  studentName: z.string().min(1).max(100).trim(),
  rollNo: z.string().min(1).max(20).trim(),
});

export const submitQuizSchema = z.object({
  attemptId: z.string().uuid().optional(),
  answers: z.array(
    z.object({
      questionId: z.string().uuid(),
      answer: z.string().max(1000).optional().nullable(),
    })
  ),
});
