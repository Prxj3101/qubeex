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
    // Look up the admin user's name
    const adminUser = await prisma_1.prisma.user.findUnique({ where: { email: invite.email } });
    return {
        valid: true,
        email: invite.email,
        institutionName: invite.institution.name,
        institutionCode: invite.institution.institutionCode,
        adminName: adminUser?.name ?? "",
        institution: invite.institution.name,
    };
};
exports.verifyInvite = verifyInvite;
const acceptInvite = async (token, password, instituteId) => {
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
    // Validate the institution code submitted by the admin matches
    if (invite.institution.institutionCode !== instituteId?.trim()) {
        throw new errors_1.BadRequestError("Invalid Institution ID");
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
    await (0, audit_service_1.logAudit)("INVITE_ACCEPTED", {
        userId: result.id,
        institutionId: result.institutionId ?? undefined,
        details: `Invite accepted by ${result.email}`,
        metadata: { email: result.email },
    });
    // Activate the institution if it was PENDING
    if (result.institutionId) {
        await prisma_1.prisma.institution.update({
            where: { id: result.institutionId },
            data: { status: "ACTIVE" },
        });
    }
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
const login = async (email, password, context = {}) => {
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
        await (0, audit_service_1.logAudit)("LOGIN_FAILED", {
            userId: user.id,
            actorRole: user.role,
            institutionId: user.institutionId ?? undefined,
            ip: context.ip,
            details: `Failed login attempt for ${email}`,
            metadata: { email, userAgent: context.userAgent },
        });
        throw new errors_1.UnauthorizedError("Invalid credentials");
    }
    await (0, audit_service_1.logAudit)("LOGIN_SUCCESS", {
        userId: user.id,
        actorRole: user.role,
        institutionId: user.institutionId ?? undefined,
        ip: context.ip,
        details: `Login by ${email}`,
        metadata: { email, userAgent: context.userAgent },
    });
    const jti = crypto_1.default.randomUUID();
    const token = jsonwebtoken_1.default.sign({
        userId: user.id,
        role: user.role,
        institutionId: user.institutionId,
        jti,
    }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    return {
        token,
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            institutionId: user.institutionId,
            createdAt: user.createdAt,
        },
    };
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
