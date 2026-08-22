// src/modules/student/tasks.schema.ts
import { z } from "zod";

// clientId: a random id the frontend generates once and persists in
// localStorage (NOT tied to the logged-in user) — identifies "this browser
// tab/app install" so the backend can tell two different devices logged
// into the same student account apart, for the single-device test lock.
export const startTestSchema = z.object({
  clientId: z.string().min(1).max(100).optional(),
});

export const heartbeatSchema = z.object({
  clientId: z.string().min(1).max(100),
});

export const submitTestSchema = z.object({
  attemptId: z.string().uuid(),
  answers: z.array(
    z.object({
      questionId: z.string().uuid(),
      answer: z.string().max(1000).optional().nullable(),
    })
  ),
  tabChangeCount: z.number().int().min(0).max(10000).optional().default(0),
});
