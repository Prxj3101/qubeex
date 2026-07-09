import { z } from "zod";

export const upsertFeePaymentSchema = z.object({
  studentId: z.string().uuid(),
  feeMonthId: z.string().min(1),
  status: z.enum(["PAID", "PENDING"]),
  paidDate: z.string().max(50).trim().nullable().optional(),
});

export type UpsertFeePaymentInput = z.infer<typeof upsertFeePaymentSchema>;
