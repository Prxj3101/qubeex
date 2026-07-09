import { z } from "zod";

export const submitOutcomesSchema = z.object({
  outcomes: z.array(z.object({
    studentId: z.string().min(1),
    outcome: z.enum(["PROMOTED", "REPEATED", "GRADUATED", "WITHDRAWN"]),
  })).min(1),
  targetDivisionId: z.string().min(1).optional(),
});

export type SubmitOutcomesInput = z.infer<typeof submitOutcomesSchema>;
