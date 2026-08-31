import { z } from "zod";

export const createDemoRequestSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().email("Invalid email address"),
  phone: z.string().trim().max(20).optional().default(""),
  institutionName: z.string().trim().min(1, "Institution name is required").max(150),
  institutionType: z.enum(["SCHOOL", "COLLEGE", "COACHING"]),
  studentCount: z.coerce.number().int().positive().optional(),
  message: z.string().trim().max(2000).optional(),
});
