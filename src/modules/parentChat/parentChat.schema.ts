import { z } from "zod";

export const attachmentSchema = z.object({
  url: z.string().url().max(1000),
  type: z.enum(["image", "pdf"]),
  name: z.string().trim().min(1).max(200),
});

export const sendMessageSchema = z
  .object({
    text: z.string().trim().max(1000, "Message is too long").optional(),
    attachment: attachmentSchema.optional(),
  })
  .refine((d) => !!d.text || !!d.attachment, { message: "Message cannot be empty" });

export const reportMessageSchema = z.object({
  reason: z.string().trim().max(300).optional(),
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
