"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resendInvite = exports.toggleInstitutionStatus = exports.updateInstitution = exports.getInstitutionById = exports.getInstitution = exports.createInstitutionService = void 0;
const prisma_1 = require("../../utils/prisma");
const token_1 = require("../../utils/token");
const email_service_1 = require("../../services/email.service");
const createInstitutionService = async (data) => {
    const { name, email, type, adminName, adminEmail } = data;
    const existingInstitution = await prisma_1.prisma.institution.findUnique({
        where: { email },
    });
    if (existingInstitution) {
        throw new Error("Institution already exists");
    }
    const existingAdmin = await prisma_1.prisma.user.findUnique({
        where: { email: adminEmail },
    });
    if (existingAdmin) {
        throw new Error("Admin already exists");
    }
    const token = (0, token_1.generateToken)();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const institution = await prisma_1.prisma.$transaction(async (tx) => {
        const newInstitution = await tx.institution.create({
            data: {
                name,
                email,
                type,
            }
        });
        await tx.user.create({
            data: {
                name: adminName,
                email: adminEmail,
                role: "ADMIN",
                institutionId: newInstitution.id,
                isActive: false,
            },
        });
        await tx.invite.create({
            data: {
                email: adminEmail,
                token,
                role: "ADMIN",
                institutionId: newInstitution.id,
                expiresAt,
            },
        });
        return newInstitution;
    });
    const inviteLink = `${process.env.FRONTEND_URL}/setup-password?token=${token}`;
    await (0, email_service_1.sendInviteEmail)({
        to: adminEmail,
        inviteLink,
    });
    return institution;
};
exports.createInstitutionService = createInstitutionService;
const getInstitution = async () => {
    return prisma_1.prisma.institution.findMany({
        include: {
            users: true,
            subscription: true,
        },
        orderBy: { createdAt: "desc" },
    });
};
exports.getInstitution = getInstitution;
const getInstitutionById = async (id) => {
    const institution = await prisma_1.prisma.institution.findUnique({
        where: { id },
        include: {
            users: true,
            subscription: true,
        },
    });
    if (!institution) {
        throw new Error("Institution not found");
    }
    return institution;
};
exports.getInstitutionById = getInstitutionById;
const updateInstitution = async (id, data) => {
    return prisma_1.prisma.institution.update({
        where: { id },
        data,
    });
};
exports.updateInstitution = updateInstitution;
const toggleInstitutionStatus = async (id, status) => {
    return prisma_1.prisma.institution.update({
        where: { id },
        data: { status },
    });
};
exports.toggleInstitutionStatus = toggleInstitutionStatus;
const resendInvite = async (email) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { email }
    });
    if (!user) {
        throw new Error("User not found");
    }
    const token = (0, token_1.generateToken)();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma_1.prisma.invite.create({
        data: {
            email,
            token,
            role: "ADMIN",
            institutionId: user.institutionId,
            expiresAt,
        },
    });
    const inviteLink = `${process.env.FRONTEND_URL}/setup-password?token=${token}`;
    await (0, email_service_1.sendInviteEmail)({
        to: user.email,
        inviteLink,
    });
    return {
        message: "Invite resent successfully",
    };
};
exports.resendInvite = resendInvite;
