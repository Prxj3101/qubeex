import { z } from "zod";
import { emailSchema } from "../auth/auth.schema";

export const createInstitutionSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(200).trim(),
  email: emailSchema,
  type: z.enum(["SCHOOL", "COLLEGE", "COACHING"]),

  adminName: z
    .string()
    .min(2, "Admin name must be at least 2 characters")
    .max(200)
    .trim(),
  adminEmail: emailSchema,
});

export const updateInstitutionSchema = z.object({
  name: z.string().min(2).max(200).trim().optional(),
  email: emailSchema.optional(),
  type: z.enum(["SCHOOL", "COLLEGE", "COACHING"]).optional(),
});

export const toggleStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});