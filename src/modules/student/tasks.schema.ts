// src/modules/student/tasks.schema.ts
import { z } from "zod";

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
