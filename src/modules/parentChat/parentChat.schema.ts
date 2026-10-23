import { z } from "zod";

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1, "Message cannot be empty").max(1000, "Message is too long"),
});

export const messagesQuerySchema = z.object({
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm");

export const chatSettingsSchema = z.object({
  enabled: z.boolean(),
  officeStart: hhmm,
  officeEnd: hhmm,
});

export const idParamSchema = z.object({ id: z.string().uuid() });
