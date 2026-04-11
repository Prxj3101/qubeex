"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logout = exports.login = exports.acceptInvite = exports.verifyInvite = void 0;
const prisma_1 = require("../../utils/prisma");
const redis_1 = require("../../utils/redis");
const token_1 = require("../../utils/token");
const audit_service_1 = require("../../services/audit.service");
const errors_1 = require("../../utils/errors");
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const JWT_SECRET = process.env.JWT_SECRET;
const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = "1h";
const verifyInvite = async (token) => {
    const tokenHash = (0, token_1.hashToken)(token);
    const invite = await prisma_1.prisma.invite.findUnique({
        where: { tokenHash },
        include: { institution: true },
    });
    if (!invite)
        throw new errors_1.BadRequestError("Invalid or expired invite");
    if (invite.isUsed)
        throw new errors_1.BadRequestError("Invalid or expired invite");
    if (invite.expiresAt < new Date()) {
        throw new errors_1.BadRequestError("Invalid or expired invite");
    }
    return {
        email: invite.email,
        institution: invite.institution.name,
    };
};
exports.verifyInvite = verifyInvite;
const acceptInvite = async (token, password) => {
    const tokenHash = (0, token_1.hashToken)(token);
    const invite = await prisma_1.prisma.invite.findUnique({
        where: { tokenHash },
    });
    if (!invite)
        throw new errors_1.BadRequestError("Invalid or expired invite");
    if (invite.isUsed)
        throw new errors_1.BadRequestError("Invalid or expired invite");
    if (invite.expiresAt < new Date()) {
        throw new errors_1.BadRequestError("Invalid or expired invite");
    }
    const hashedPassword = await bcrypt_1.default.hash(password, BCRYPT_ROUNDS);
    const user = await prisma_1.prisma.user.findUnique({
        where: { email: invite.email },
    });
    if (!user)
        throw new errors_1.BadRequestError("Invalid or expired invite");
    const result = await prisma_1.prisma.$transaction(async (tx) => {
        const updatedUser = await tx.user.update({
            where: { email: invite.email },
            data: {
                password: hashedPassword,
                isActive: true,
            },
            omit: { password: true },
        });
        await tx.invite.update({
            where: { id: invite.id },
            data: { isUsed: true },
        });
        return updatedUser;
    });
    await (0, audit_service_1.logAudit)("INVITE_ACCEPTED", result.id, {
        email: result.email,
        institutionId: result.institutionId,
    });
    const jti = crypto_1.default.randomUUID();
    const accessToken = jsonwebtoken_1.default.sign({
        userId: result.id,
        role: result.role,
        institutionId: result.institutionId,
        jti,
    }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    return { token: accessToken };
};
exports.acceptInvite = acceptInvite;
const login = async (email, password) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { email },
    });
    if (!user || !user.password) {
        throw new errors_1.UnauthorizedError("Invalid credentials");
    }
    if (!user.isActive) {
        throw new errors_1.UnauthorizedError("Invalid credentials");
    }
    const isMatch = await bcrypt_1.default.compare(password, user.password);
    if (!isMatch) {
        await (0, audit_service_1.logAudit)("LOGIN_FAILED", undefined, { email });
        throw new errors_1.UnauthorizedError("Invalid credentials");
    }
    await (0, audit_service_1.logAudit)("LOGIN_SUCCESS", user.id, { email });
    const jti = crypto_1.default.randomUUID();
    const token = jsonwebtoken_1.default.sign({
        userId: user.id,
        role: user.role,
        institutionId: user.institutionId,
        jti,
    }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    return { token };
};
exports.login = login;
const logout = async (jti, exp) => {
    if (!redis_1.redis) {
        return { message: "Logged out (stateless)" };
    }
    const ttl = Math.max(exp - Math.floor(Date.now() / 1000), 0);
    await redis_1.redis.setex(`bl:${jti}`, ttl, "1");
    return { message: "Logged out successfully" };
};
exports.logout = logout;
