import { z } from "zod";

export const BORROWER_TYPES = ["STUDENT", "TEACHER", "STAFF"] as const;
export const FINES_MODES = ["OFF", "LIBRARIAN", "FEES"] as const;

export const ruleSchema = z.object({
  maxBooks: z.number().int().min(1).max(1000),
  loanDays: z.number().int().min(1).max(3650),
  maxRenewals: z.number().int().min(0).max(100),
  finePerDayPaise: z.number().int().min(0).max(10_000_000),
  graceDays: z.number().int().min(0).max(365),
  fineCapPaise: z.number().int().min(0).max(100_000_000).nullable(),
}).strict();

export const settingsSchema = z.object({
  finesMode: z.enum(FINES_MODES),
  dueSoonDays: z.number().int().min(0).max(30),
  lostChargePaise: z.number().int().min(0).max(100_000_000),
  damagedChargePaise: z.number().int().min(0).max(100_000_000),
  rules: z.object({ STUDENT: ruleSchema, TEACHER: ruleSchema, STAFF: ruleSchema }).strict(),
}).strict();

export type SettingsInput = z.infer<typeof settingsSchema>;

const optText = (max: number) => z.string().trim().max(max).optional();

export const bookFieldsSchema = {
  title: z.string().trim().min(1).max(300),
  author: optText(200),
  isbn: optText(20),
  category: optText(100),
  language: optText(50),
  shelf: optText(100),
  pricePaise: z.number().int().min(0).max(100_000_000).optional(),
  coverUrl: z.string().trim().url().max(500).optional(),
};

export const createBookSchema = z.object({ ...bookFieldsSchema, copies: z.number().int().min(1).max(500) }).strict();
export const updateBookSchema = z.object(bookFieldsSchema).partial().strict();
export const addCopiesSchema = z.object({ count: z.number().int().min(1).max(500) }).strict();
export const copyStatusSchema = z.object({ status: z.enum(["AVAILABLE", "LOST", "DAMAGED", "WITHDRAWN"]) }).strict();
export const idSchema = z.string().uuid();
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
