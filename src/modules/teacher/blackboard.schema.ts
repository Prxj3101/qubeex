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
  // Teacher's free-text guidance, kept separate from `pageText` so the prompt
  // can treat the page content as the primary source of truth and this as
  // secondary instructions shaping the output (e.g. "focus on the diagrams").
  instructions: z.string().max(500).trim().optional(),
  // "summary" (default): topic/overview/keyPoints, unchanged. "notes": also
  // generates a longer, free-form `detailedNotes` field for teachers who
  // explicitly want a fuller written explanation rather than a bullet recap.
  mode: z.enum(["summary", "notes"]).optional().default("summary"),
});

export const aiChatSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().min(1).max(4000).trim(),
    })
  ).min(1).max(20),
  context: z.string().max(500).trim().optional(),
  // Text of the pages currently open on the blackboard. Lets the assistant
  // answer against what's actually being taught rather than just a filename —
  // it's run through the same cached context extraction aiScan uses, so when
  // the teacher has already scanned these pages it costs nothing extra.
  pageText: z.string().max(8000).trim().optional(),
});

export const aiQuizSchema = z.object({
  topic: z.string().min(1).max(200).trim(),
  count: z.number().int().min(1).max(10).optional().default(5),
  difficulty: z.enum(["easy", "medium", "hard"]).optional().default("medium"),
  pageText: z.string().max(8000).trim().optional(),
  // Kept separate from `topic` for the same reason as aiScan: merged into one
  // string, guidance competes with the subject instead of shaping the output.
  instructions: z.string().max(500).trim().optional(),
});

export const aiMindmapSchema = z.object({
  topic: z.string().min(1).max(200).trim(),
  pageText: z.string().max(8000).trim().optional(),
  instructions: z.string().max(500).trim().optional(),
  // No depth option on purpose. It was a teacher-facing choice where one of
  // the values was simply wrong — depth 1 produced branches with nothing
  // under them, i.e. a list of headings rather than a mindmap. The shape a
  // good study map wants is always the same, so the model is told to produce
  // it rather than asked how deep to go.
});
