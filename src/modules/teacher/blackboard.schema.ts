import { z } from "zod";

export const createFolderSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  parentId: z.string().uuid().optional(),
});

export const uploadFileSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
});

export const aiScanSchema = z.object({
  topic: z.string().min(1).max(200).trim(),
  pageText: z.string().max(8000).trim().optional(),
});

export const aiChatSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().min(1).max(4000).trim(),
    })
  ).min(1).max(20),
  context: z.string().max(500).trim().optional(),
});

export const aiQuizSchema = z.object({
  topic: z.string().min(1).max(200).trim(),
  count: z.number().int().min(1).max(10).optional().default(5),
  difficulty: z.enum(["easy", "medium", "hard"]).optional().default("medium"),
  pageText: z.string().max(8000).trim().optional(),
});
