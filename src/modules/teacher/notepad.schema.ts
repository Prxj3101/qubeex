// src/modules/teacher/notepad.schema.ts
import { z } from "zod";

export const NOTE_COLORS = ["#FEF08A", "#BBF7D0", "#BFDBFE", "#FED7AA", "#E9D5FF"] as const;

export const createNoteSchema = z.object({
  text: z.string().min(1).max(500).trim(),
  color: z.enum(NOTE_COLORS),
});

export const updateNoteSchema = z.object({
  text: z.string().min(1).max(500).trim(),
});

export const createTaskSchema = z.object({
  text: z.string().min(1).max(300).trim(),
});

export const updateTaskSchema = z
  .object({
    text: z.string().min(1).max(300).trim().optional(),
    done: z.boolean().optional(),
  })
  .refine((d) => d.text !== undefined || d.done !== undefined, {
    message: "At least one field required",
  });
