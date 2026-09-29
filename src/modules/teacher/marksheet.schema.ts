import { z } from "zod";

const gradeScaleItemSchema = z.object({
  grade: z.string().min(1).max(10),
  minPercent: z.number().min(0).max(100),
});

export const addColumnSchema = z.object({
  subjectId: z.string().uuid(),
  name: z.string().min(1).max(100).trim(),
  maxMarks: z.number().positive().max(1000),
  examDate: z.string().datetime({ offset: true }).optional().nullable(),
});

export const editColumnSchema = z
  .object({
    name: z.string().min(1).max(100).trim().optional(),
    maxMarks: z.number().positive().max(1000).optional(),
    examDate: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .refine(
    (d) => d.name !== undefined || d.maxMarks !== undefined || d.examDate !== undefined,
    { message: "At least one field required" }
  );

export const reorderColumnsSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});

export const subjectConfigSchema = z.object({
  passingMarks: z.number().min(0),
  gradeScale: z.array(gradeScaleItemSchema),
});

const scoreItemSchema = z.object({
  studentId: z.string().uuid(),
  examColumnId: z.string().uuid(),
  score: z.number().min(0).nullable(),
  isAbsent: z.boolean(),
});

export const bulkScoresSchema = z.object({
  scores: z.array(scoreItemSchema).min(1),
});

export const addGradedSubjectSchema = z.object({
  name: z.string().min(1).max(100).trim(),
});

export const editGradedSubjectSchema = z.object({
  name: z.string().min(1).max(100).trim(),
});

export const reorderGradedSubjectsSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});

export const gradedSectionTitleSchema = z.object({
  title: z.string().min(1).max(100).trim(),
});

// Grade letters are validated against the marksheet's own configured grade
// scale in the controller (bulkUpsertGradedScores), not a fixed list here —
// the class teacher can define arbitrary grade labels (e.g. "B+").
const gradedScoreItemSchema = z.object({
  gradedSubjectId: z.string().uuid(),
  studentId: z.string().uuid(),
  term1Grade: z.string().min(1).max(10).trim().nullable().optional(),
  term2Grade: z.string().min(1).max(10).trim().nullable().optional(),
});

export const bulkGradedScoresSchema = z.object({
  scores: z.array(gradedScoreItemSchema).min(1),
});

// Per-student "Conduct" + "Remarks" on the offline report card — class
// teacher only, one row per student, not tied to any subject/exam column.
export const upsertMarksheetRemarkSchema = z.object({
  conduct: z.string().max(200).trim().nullable().optional(),
  remarks: z.string().max(1000).trim().nullable().optional(),
});

const marksheetGradeScaleEntrySchema = z.object({
  grade: z.string().min(1).max(10).trim(),
  minPct: z.number().min(0).max(100),
});

export const updateMarksheetGradeScaleSchema = z.object({
  gradeScale: z
    .array(marksheetGradeScaleEntrySchema)
    .min(1)
    .refine(
      (entries) => new Set(entries.map((e) => e.minPct)).size === entries.length,
      { message: "Each grade must have a unique minimum percentage" }
    ),
});
