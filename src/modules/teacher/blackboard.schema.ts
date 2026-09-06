import { z } from "zod";

// Upper bound on the page text a client may send. Sized so a full 10-page
// selection (the client's MAX_SELECTABLE_PAGES) fits: a textbook page runs
// 2,500-3,500 characters, so 10 pages is ~30,000. The previous 8,000 silently
// truncated any selection past ~2-3 pages — the teacher picked ten pages and
// the AI read three, with no indication which. Keep in sync with
// PAGE_TEXT_CHAR_LIMIT in the web client (set slightly below this).
const PAGE_TEXT_MAX_CHARS = 34_000;

export const createFolderSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  parentId: z.string().uuid().optional(),
});

export const uploadFileSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
});

export const aiScanSchema = z.object({
  topic: z.string().min(1).max(200).trim(),
  pageText: z.string().max(PAGE_TEXT_MAX_CHARS).trim().optional(),
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
  pageText: z.string().max(PAGE_TEXT_MAX_CHARS).trim().optional(),
});

export const aiQuizSchema = z.object({
  topic: z.string().min(1).max(200).trim(),
  count: z.number().int().min(1).max(10).optional().default(5),
  difficulty: z.enum(["easy", "medium", "hard"]).optional().default("medium"),
  pageText: z.string().max(PAGE_TEXT_MAX_CHARS).trim().optional(),
  // Kept separate from `topic` for the same reason as aiScan: merged into one
  // string, guidance competes with the subject instead of shaping the output.
  instructions: z.string().max(500).trim().optional(),
});

export const aiMindmapSchema = z.object({
  topic: z.string().min(1).max(200).trim(),
  pageText: z.string().max(PAGE_TEXT_MAX_CHARS).trim().optional(),
  instructions: z.string().max(500).trim().optional(),
  // No depth option on purpose. It was a teacher-facing choice where one of
  // the values was simply wrong — depth 1 produced branches with nothing
  // under them, i.e. a list of headings rather than a mindmap. The shape a
  // good study map wants is always the same, so the model is told to produce
  // it rather than asked how deep to go.
});
