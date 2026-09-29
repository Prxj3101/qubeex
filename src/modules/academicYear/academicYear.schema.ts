import { z } from "zod";

export const startNewAcademicYearSchema = z
  .object({
    // Matches the "YYYY-YY" format used throughout the codebase, e.g.
    // computeDefaultAcademicYearWindow's output (src/utils/academicYear.ts).
    label: z.string().regex(/^\d{4}-\d{2}$/, "label must match YYYY-YY, e.g. 2024-25"),
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
  })
  .refine((data) => new Date(data.endDate) > new Date(data.startDate), {
    message: "endDate must be after startDate",
    path: ["endDate"],
  });

export type StartNewAcademicYearInput = z.infer<typeof startNewAcademicYearSchema>;
