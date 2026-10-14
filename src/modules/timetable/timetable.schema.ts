import { z } from "zod";

const day = z.number().int().min(1).max(7);
const minute = z.number().int().min(0).max(1440);
const id = z.string().min(1).max(64);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const yearQuery = z.object({ academicYearId: id.optional() });

export const workingDaysSchema = z.object({
  workingDays: z.array(day).min(1).max(7).refine((a) => new Set(a).size === a.length, "Duplicate days"),
});

export const slotBodySchema = z.object({
  name: z.string().trim().min(1).max(40),
  startMinute: minute,
  endMinute: minute,
  kind: z.enum(["PERIOD", "BREAK", "LUNCH", "ASSEMBLY", "ACTIVITY"]).default("PERIOD"),
}).refine((s) => s.endMinute > s.startMinute, { message: "End time must be after start time", path: ["endMinute"] });

export const slotPatchSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  startMinute: minute.optional(),
  endMinute: minute.optional(),
  kind: z.enum(["PERIOD", "BREAK", "LUNCH", "ASSEMBLY", "ACTIVITY"]).optional(),
});

export const slotReorderSchema = z.object({ orderedIds: z.array(id).min(1) });
export const copyYearSchema = z.object({ fromAcademicYearId: id });

const sessionKind = z.enum([
  "THEORY", "PRACTICAL", "LAB", "ACTIVITY", "PE_SPORTS", "LIBRARY", "CLASS_TEACHER",
  "ASSEMBLY", "BREAK", "LUNCH", "FREE", "EXAM", "CUSTOM",
]);

export const sessionTypeSchema = z.object({
  name: z.string().trim().min(1).max(50),
  kind: sessionKind,
  requiresTeacher: z.boolean().default(true),
  requiresRoom: z.boolean().default(false),
  roomType: z.string().trim().max(40).nullable().optional(),
  defaultSpan: z.number().int().min(1).max(6).default(1),
  color: z.string().max(20).nullable().optional(),
  isActive: z.boolean().optional(),
});
export const sessionTypePatchSchema = sessionTypeSchema.partial();

export const roomSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.string().trim().min(1).max(40).default("CLASSROOM"),
  capacity: z.number().int().min(0).max(10000).nullable().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(500).nullable().optional(),
});
export const roomPatchSchema = roomSchema.partial();

const cell = z.object({ dayOfWeek: day, slotId: id });
export const cellsSchema = z.object({ cells: z.array(cell).max(500) });
export const availabilitySchema = z.object({
  unavailable: z.array(cell).max(500).default([]),
  preferred: z.array(cell).max(500).default([]),
});
export const teacherPrefSchema = z.object({
  maxPeriodsPerDay: z.number().int().min(1).max(20).nullable(),
  maxConsecutive: z.number().int().min(1).max(20).nullable(),
  maxPeriodsPerWeek: z.number().int().min(1).max(100).nullable(),
});

export const configItemSchema = z.object({
  id: id.optional(),
  subjectId: id.nullable().optional(),
  sessionTypeId: id,
  title: z.string().trim().max(80).nullable().optional(),
  periodsPerWeek: z.number().int().min(1).max(60),
  span: z.number().int().min(1).max(6).default(1),
  maxPerDay: z.number().int().min(1).max(10).default(1),
  teacherId: id.nullable().optional(),
  roomId: id.nullable().optional(),
  roomType: z.string().trim().max(40).nullable().optional(),
});
export const configsSchema = z.object({ configs: z.array(configItemSchema).max(100) });

export const forceSchema = z.object({ force: z.boolean().optional() });

export const entryCreateSchema = forceSchema.extend({
  dayOfWeek: day,
  slotId: id,
  sessionTypeId: id,
  subjectId: id.nullable().optional(),
  title: z.string().trim().max(80).nullable().optional(),
  teacherId: id.nullable().optional(),
  roomId: id.nullable().optional(),
  configId: id.nullable().optional(),
  span: z.number().int().min(1).max(6).optional(),
});
export const entryPatchSchema = forceSchema.extend({
  sessionTypeId: id.optional(),
  subjectId: id.nullable().optional(),
  title: z.string().trim().max(80).nullable().optional(),
  teacherId: id.nullable().optional(),
  roomId: id.nullable().optional(),
});
export const entryMoveSchema = forceSchema.extend({ entryId: id, toDayOfWeek: day, toSlotId: id });
export const entrySwapSchema = forceSchema.extend({ entryAId: id, entryBId: id });
export const entryDeleteSchema = forceSchema;

export const generateSchema = z.object({ keepLocked: z.boolean().default(true), variation: z.number().int().optional() });
export const generateBulkSchema = z.object({
  standardId: id.optional(),
  divisionIds: z.array(id).max(300).optional(),
  keepLocked: z.boolean().default(true),
  variation: z.number().int().optional(),
});
export const applyToAllSchema = forceSchema.extend({
  dayOfWeek: day.optional(),
  slotId: id,
  sessionTypeId: id,
  title: z.string().trim().max(80).nullable().optional(),
  standardId: id.optional(),
  days: z.array(day).max(7).optional(),
});

export const statusSchema = forceSchema.extend({
  status: z.enum(["DRAFT", "GENERATED", "UNDER_REVIEW", "PUBLISHED", "ARCHIVED"]),
});
export const bulkStatusSchema = forceSchema.extend({
  status: z.enum(["PUBLISHED", "DRAFT", "ARCHIVED", "UNDER_REVIEW"]),
  divisionIds: z.array(id).min(1).max(300),
});

export const exceptionSchema = forceSchema.extend({
  divisionId: id,
  date: dateStr,
  slotId: id,
  kind: z.enum(["OVERRIDE", "CANCEL"]).default("OVERRIDE"),
  sessionTypeId: id.nullable().optional(),
  subjectId: id.nullable().optional(),
  title: z.string().trim().max(80).nullable().optional(),
  teacherId: id.nullable().optional(),
  roomId: id.nullable().optional(),
  reason: z.string().trim().max(300).nullable().optional(),
});

export const substitutionSchema = forceSchema.extend({
  entryId: id,
  date: dateStr,
  substituteTeacherId: id,
  reason: z.string().trim().max(300).nullable().optional(),
});

export const weekQuery = z.object({
  academicYearId: id.optional(),
  date: dateStr.optional(),
});

const snapshotEntry = z.object({
  dayOfWeek: day,
  slotId: id,
  sessionTypeId: id,
  subjectId: id.nullable().optional(),
  title: z.string().trim().max(80).nullable().optional(),
  teacherId: id.nullable().optional(),
  roomId: id.nullable().optional(),
  configId: id.nullable().optional(),
  groupKey: z.string().max(64).nullable().optional(),
  isLocked: z.boolean().optional(),
});
export const restoreSchema = z.object({ entries: z.array(snapshotEntry).min(1).max(400) });
export const copyDaySchema = forceSchema.extend({
  fromDay: day,
  toDays: z.array(day).min(1).max(6),
  overwrite: z.boolean().default(false),
});
export const bulkDeleteSchema = z.object({ ids: z.array(id).min(1).max(400) });
export const clearSchema = z.object({ keepLocked: z.boolean().default(true), dayOfWeek: day.optional() });

export const copyConfigsSchema = z.object({
  /** Omit to copy to every other section of the same class. */
  targetDivisionIds: z.array(id).max(100).optional(),
});
export const generatePublishSchema = z.object({
  standardId: id.optional(),
  divisionIds: z.array(id).max(300).optional(),
  keepLocked: z.boolean().default(true),
  variation: z.number().int().optional(),
});
