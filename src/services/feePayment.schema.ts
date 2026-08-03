import { z } from "zod";

export const upsertFeePaymentSchema = z.object({
  studentId: z.string().uuid(),
  feeMonthId: z.string().min(1),
  status: z.enum(["PAID", "PENDING"]),
  // No .trim() here — these are free-text display fields (not parsed as a
  // real date), and trimming server-side caused a mid-typing round-trip to
  // strip a trailing space the user just typed, which looked like an
  // auto-backspace.
  paidDate: z.string().max(50).nullable().optional(),
  remark: z.string().max(500).nullable().optional(),
  // { [extraColumn.label]: value } — keyed by label since extra columns have
  // no stable id today (just a label array on the fee structure).
  extraFields: z.record(z.string(), z.string()).nullable().optional(),
  // Extra fee structure IDs (e.g. Penalty/Fine) added just for this student
  // in this month, on top of the division's shared assignedStructureIds.
  extraStructureIds: z.array(z.string()).nullable().optional(),
});

export type UpsertFeePaymentInput = z.infer<typeof upsertFeePaymentSchema>;
