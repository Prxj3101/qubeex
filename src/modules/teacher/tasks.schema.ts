// src/modules/teacher/tasks.schema.ts
import { z } from "zod";

export const generateQuestionsSchema = z.object({
  containerId: z.string().uuid(),
  prompt: z.string().max(500).trim().optional(),
  more: z.boolean().optional().default(false),
});

export const editQuestionSchema = z.object({
  question: z.string().min(1).max(2000).trim(),
  questionTemplate: z.string().max(2000).trim().optional(),
  options: z.array(z.string().min(1).max(500).trim()).length(4).optional(),
  answer: z.string().min(1).max(1000).trim(),
});

export const createManualQuestionSchema = z.object({
  containerId: z.string().uuid(),
  type: z.enum(["MCQ", "FILL_BLANK", "TRUE_FALSE", "SHORT_ANSWER", "CONCEPTUAL", "NUMERICAL"]),
  question: z.string().min(1).max(2000).trim(),
  answer: z.string().min(1).max(1000).trim(),
  options: z.array(z.string().min(1).max(500).trim()).length(4).optional(),
  formula: z.string().max(500).trim().optional(),
  category: z.string().max(100).trim().optional(),
});

export const createShareTokenSchema = z.object({
  questionIds: z.array(z.string().uuid()).min(1).max(200),
});

export const importQuestionsSchema = z.object({
  token: z.string().uuid(),
  containerId: z.string().uuid(),
  questionIds: z.array(z.string().uuid()).min(1),
});

export const createAssignmentSchema = z.object({
  divisionId: z.string().min(1),
  subjectId: z.string().uuid().optional(),
  title: z.string().min(1).max(200).trim(),
  description: z.string().max(2000).trim().optional(),
  totalMarks: z.number().int().min(1).max(500).optional().default(10),
  dueDate: z.string().datetime().optional().nullable(),
  submissionType: z.enum(["OFFLINE", "ONLINE"]).optional().default("OFFLINE"),
});

export const updateAssignmentSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(2000).trim().optional().nullable(),
  totalMarks: z.number().int().min(1).max(500).optional(),
  dueDate: z.string().datetime().optional().nullable(),
  submissionType: z.enum(["OFFLINE", "ONLINE"]).optional(),
  status: z.enum(["DRAFT", "ACTIVE", "COMPLETED"]).optional(),
}).refine(d => Object.values(d).some(v => v !== undefined), { message: "At least one field required" });

export const createModuleSchema = z.object({
  divisionId: z.string().min(1),
  subjectId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).trim(),
  description: z.string().max(500).trim().optional(),
});

export const editModuleSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(500).trim().optional(),
}).refine(d => d.name !== undefined || d.description !== undefined, {
  message: "At least one field required",
});

export const createContainerSchema = z.object({
  divisionId: z.string().min(1),
  subjectId: z.string().uuid().optional(),
  name: z.string().min(1).max(100).trim(),
});

export const renameContainerSchema = z.object({
  name: z.string().min(1).max(100).trim(),
});

export const assignQuestionSchema = z.object({
  questionId: z.string().uuid(),
});

export const createTestSchema = z.object({
  divisionId: z.string().min(1),
  subjectId: z.string().uuid().optional(),
  title: z.string().min(1).max(200).trim(),
  description: z.string().max(2000).trim().optional(),
  durationMinutes: z.number().int().min(5).max(300).optional(),
  totalMarks: z.number().int().min(1).max(1000).optional().default(100),
  numberOfQuestions: z.number().int().min(1).max(100),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  startDate: z.string().datetime().optional().nullable(),
  validUntil: z.string().datetime().optional().nullable(),
});

export const updateTestSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(2000).trim().optional().nullable(),
  durationMinutes: z.number().int().min(5).max(300).optional(),
  totalMarks: z.number().int().min(1).max(1000).optional(),
  numberOfQuestions: z.number().int().min(1).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  startDate: z.string().datetime().optional().nullable(),
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
