"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toggleStatusSchema = exports.updateInstitutionSchema = exports.createInstitutionSchema = void 0;
const zod_1 = require("zod");
exports.createInstitutionSchema = zod_1.z.object({
    name: zod_1.z.string().min(2),
    email: zod_1.z.string().email("Invalid email address"),
    type: zod_1.z.enum(["SCHOOL", "COLLEGE", "COACHING"]),
    adminName: zod_1.z.string().min(2),
    adminEmail: zod_1.z.string().email("Invalid email address"),
});
exports.updateInstitutionSchema = zod_1.z.object({
    name: zod_1.z.string().optional(),
    email: zod_1.z.string().email().optional(),
    type: zod_1.z.enum(["SCHOOL", "COLLEGE", "COACHING"]).optional(),
});
exports.toggleStatusSchema = zod_1.z.object({
    status: zod_1.z.enum(["ACTIVE", "SUSPENDED"])
});
