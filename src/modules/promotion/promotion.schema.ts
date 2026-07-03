import { z } from "zod";

export const promoteStudentsSchema = z
  .object({
    studentIds: z.array(z.string()).min(1),
    action: z.enum(["PROMOTE", "GRADUATE"]),
    targetDivisionId: z.string().optional(),
  })
  .refine((data) => data.action !== "PROMOTE" || !!data.targetDivisionId, {
    message: "targetDivisionId is required when action is PROMOTE",
    path: ["targetDivisionId"],
  });

export type PromoteStudentsInput = z.infer<typeof promoteStudentsSchema>;
