import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm");

export const createFormSchema = z.object({
  kind: z.enum(["SLIP", "POLL"]),
  title: z.string().trim().min(1, "Title is required").max(120),
  description: z.string().trim().max(1000).optional(),
  options: z.array(z.string().trim().min(1).max(80)).max(6).optional(),
  allowComment: z.boolean().default(true),
  deadline: z.coerce.date().optional(),
  divisionIds: z.array(z.string().uuid()).max(100).optional(),
  allDivisions: z.boolean().optional(),
});

export const respondSchema = z.object({
  optionIndex: z.number().int().min(0).max(5),
  comment: z.string().trim().max(300).optional(),
});

export const createSessionSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  startTime: hhmm,
  endTime: hhmm,
  slotMinutes: z.number().int().min(5).max(60),
  location: z.string().trim().max(100).optional(),
  note: z.string().trim().max(300).optional(),
});

export const idParamSchema = z.object({ id: z.string().uuid() });
