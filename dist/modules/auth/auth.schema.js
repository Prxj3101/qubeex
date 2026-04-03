"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginSchema = exports.acceptInviteSchema = void 0;
const zod_1 = require("zod");
exports.acceptInviteSchema = zod_1.z.object({
    token: zod_1.z.string(),
    password: zod_1.z.string().min(6),
});
exports.loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
});
