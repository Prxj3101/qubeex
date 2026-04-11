"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toggleStatusSchema = exports.updateInstitutionSchema = exports.createInstitutionSchema = void 0;
const zod_1 = require("zod");
const auth_schema_1 = require("../auth/auth.schema");
exports.createInstitutionSchema = zod_1.z.object({
    name: zod_1.z.string().min(2, "Name must be at least 2 characters").max(200).trim(),
    email: auth_schema_1.emailSchema,
    type: zod_1.z.enum(["SCHOOL", "COLLEGE", "COACHING"]),
    adminName: zod_1.z
        .string()
        .min(2, "Admin name must be at least 2 characters")
        .max(200)
        .trim(),
    adminEmail: auth_schema_1.emailSchema,
});
exports.updateInstitutionSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(200).trim().optional(),
    email: auth_schema_1.emailSchema.optional(),
    type: zod_1.z.enum(["SCHOOL", "COLLEGE", "COACHING"]).optional(),
});
exports.toggleStatusSchema = zod_1.z.object({
    status: zod_1.z.enum(["ACTIVE", "SUSPENDED"]),
});
