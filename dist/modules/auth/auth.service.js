"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = exports.acceptInvite = exports.verifyInvite = void 0;
const prisma_1 = require("../../utils/prisma");
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET;
const verifyInvite = async (token) => {
    const invite = await prisma_1.prisma.invite.findUnique({
        where: { token },
        include: {
            institution: true,
        },
    });
    if (!invite)
        throw new Error("Invalid Invite");
    if (invite.isUsed)
        throw new Error("Invite already used");
    if (invite.expiresAt < new Date) {
        throw new Error("Invite has expired");
    }
    return {
        email: invite.email,
        institution: invite.institution.name,
    };
};
exports.verifyInvite = verifyInvite;
const acceptInvite = async (token, password) => {
    const invite = await prisma_1.prisma.invite.findUnique({
        where: { token },
    });
    if (!invite)
        throw new Error("Invalid Invite");
    if (invite.isUsed)
        throw new Error("Invite already used");
    if (invite.expiresAt < new Date) {
        throw new Error("Invite has expired");
    }
    const hashedPassword = await bcrypt_1.default.hash(password, 10);
    const user = await prisma_1.prisma.user.findUnique({
        where: {
            email: invite.email,
        }
    });
    if (!user)
        throw new Error("User not found");
    const result = await prisma_1.prisma.$transaction(async (tx) => {
        const updatedUser = await tx.user.update({
            where: {
                email: invite.email,
            },
            data: {
                password: hashedPassword,
                isActive: true,
            },
        });
        await tx.invite.update({
            where: {
                id: invite.id,
            },
            data: {
                isUsed: true,
            },
        });
        return updatedUser;
    });
    const tokenJWT = jsonwebtoken_1.default.sign({
        userId: result.id,
        role: result.role,
        institutionId: result.institutionId,
    }, JWT_SECRET, {
        expiresIn: "7d",
    });
    return { token: tokenJWT };
};
exports.acceptInvite = acceptInvite;
const login = async (email, password) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { email },
    });
    if (!user)
        throw new Error("User not found");
    if (!user.isActive)
        throw new Error("Account is not Active");
    const isMatch = await bcrypt_1.default.compare(password, user.password);
    if (!isMatch)
        throw new Error("Invalid credentials");
    const token = jsonwebtoken_1.default.sign({
        userId: user.id,
        role: user.role,
        institutionId: user.institutionId,
    }, JWT_SECRET, {
        expiresIn: "7d",
    });
    return { token };
};
exports.login = login;
