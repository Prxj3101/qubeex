import { z } from "zod";

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(100, "Password must be at most 100 characters")
  .regex(/[A-Z]/, "Must include at least one uppercase letter")
  .regex(/[0-9]/, "Must include at least one number")
  .regex(/[^A-Za-z0-9]/, "Must include at least one special character");

// Simpler schema used at login — avoids rejecting valid passwords with
// a different composition than our rules (e.g. SuperAdmin seed password)
const loginPasswordSchema = z.string().min(1, "Password is required").max(100);

export const emailSchema = z
  .string()
  .email("Invalid email address")
  .max(255, "Email is too long")
  .toLowerCase()
  .trim();

export const acceptInviteSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: passwordSchema,
  // Frontend sends instituteId as a UX confirmation step — we accept but don't require it
  instituteId: z.string().optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: loginPasswordSchema,
});