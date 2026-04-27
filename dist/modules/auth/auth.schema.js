"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginSchema = exports.acceptInviteSchema = exports.emailSchema = exports.passwordSchema = void 0;
const zod_1 = require("zod");
exports.passwordSchema = zod_1.z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(100, "Password must be at most 100 characters")
    .regex(/[A-Z]/, "Must include at least one uppercase letter")
    .regex(/[0-9]/, "Must include at least one number")
    .regex(/[^A-Za-z0-9]/, "Must include at least one special character");
// Simpler schema used at login — avoids rejecting valid passwords with
// a different composition than our rules (e.g. SuperAdmin seed password)
const loginPasswordSchema = zod_1.z.string().min(1, "Password is required").max(100);
exports.emailSchema = zod_1.z
    .string()
    .email("Invalid email address")
    .max(255, "Email is too long")
    .toLowerCase()
    .trim();
exports.acceptInviteSchema = zod_1.z.object({
    token: zod_1.z.string().min(1, "Token is required"),
    password: exports.passwordSchema,
    instituteId: zod_1.z.string().min(1, "Institution ID is required").trim(),
});
exports.loginSchema = zod_1.z.object({
    email: exports.emailSchema,
    password: loginPasswordSchema,
});
