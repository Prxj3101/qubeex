// src/modules/admin/notepad.schema.ts
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
  // ISO datetime string — optional, set manually or by Jarvis when the admin
  // asks for a reminder at a specific time.
  dueAt: z.string().datetime().optional(),
});

export const updateTaskSchema = z
  .object({
    text: z.string().min(1).max(300).trim().optional(),
    done: z.boolean().optional(),
    // Allow explicitly clearing a due date (null) as well as setting one.
    dueAt: z.string().datetime().nullable().optional(),
  })
  .refine((d) => d.text !== undefined || d.done !== undefined || d.dueAt !== undefined, {
    message: "At least one field required",
  });
