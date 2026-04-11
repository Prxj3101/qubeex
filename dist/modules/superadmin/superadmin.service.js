"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resendInvite = exports.toggleInstitutionStatus = exports.updateInstitution = exports.getInstitutionById = exports.getInstitution = exports.createInstitutionService = void 0;
const prisma_1 = require("../../utils/prisma");
const token_1 = require("../../utils/token");
const email_service_1 = require("../../services/email.service");
const audit_service_1 = require("../../services/audit.service");
const errors_1 = require("../../utils/errors");
const createInstitutionService = async (data) => {
    const { name, email, type, adminName, adminEmail } = data;
    const existingInstitution = await prisma_1.prisma.institution.findUnique({
        where: { email },
    });
    if (existingInstitution) {
        throw new errors_1.ConflictError("Institution with this email already exists");
    }
    const existingAdmin = await prisma_1.prisma.user.findUnique({
        where: { email: adminEmail },
    });
    if (existingAdmin) {
        throw new errors_1.ConflictError("A user with this email already exists");
    }
    const rawToken = (0, token_1.generateToken)();
    const tokenHash = (0, token_1.hashToken)(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const institution = await prisma_1.prisma.$transaction(async (tx) => {
        const newInstitution = await tx.institution.create({
            data: { name, email, type },
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
                tokenHash,
                role: "ADMIN",
                institutionId: newInstitution.id,
                expiresAt,
            },
        });
        return newInstitution;
    });
    const inviteLink = `${process.env.FRONTEND_URL}/setup-password?token=${rawToken}`;
    await (0, email_service_1.sendInviteEmail)({
        to: adminEmail,
        inviteLink,
    });
    await (0, audit_service_1.logAudit)("INSTITUTION_CREATED", undefined, {
        institutionId: institution.id,
        institutionName: name,
        adminEmail,
    });
    return institution;
};
exports.createInstitutionService = createInstitutionService;
const getInstitution = async () => {
    return prisma_1.prisma.institution.findMany({
        include: {
            users: {
                omit: { password: true },
            },
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
            users: {
                omit: { password: true },
            },
            subscription: true,
        },
    });
    if (!institution) {
        throw new errors_1.NotFoundError("Institution not found");
    }
    return institution;
};
exports.getInstitutionById = getInstitutionById;
const updateInstitution = async (id, data) => {
    const existing = await prisma_1.prisma.institution.findUnique({ where: { id } });
    if (!existing)
        throw new errors_1.NotFoundError("Institution not found");
    return prisma_1.prisma.institution.update({
        where: { id },
        data,
    });
};
exports.updateInstitution = updateInstitution;
const toggleInstitutionStatus = async (id, status) => {
    const existing = await prisma_1.prisma.institution.findUnique({ where: { id } });
    if (!existing)
        throw new errors_1.NotFoundError("Institution not found");
    const result = await prisma_1.prisma.institution.update({
        where: { id },
        data: { status },
    });
    await (0, audit_service_1.logAudit)("INSTITUTION_STATUS_CHANGED", undefined, {
        institutionId: id,
        newStatus: status,
    });
    return result;
};
exports.toggleInstitutionStatus = toggleInstitutionStatus;
const resendInvite = async (email) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { email },
    });
    if (!user) {
        throw new errors_1.NotFoundError("User not found");
    }
    const rawToken = (0, token_1.generateToken)();
    const tokenHash = (0, token_1.hashToken)(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma_1.prisma.invite.create({
        data: {
            email,
            tokenHash,
            role: "ADMIN",
            institutionId: user.institutionId,
            expiresAt,
        },
    });
    const inviteLink = `${process.env.FRONTEND_URL}/setup-password?token=${rawToken}`;
    await (0, email_service_1.sendInviteEmail)({
        to: user.email,
        inviteLink,
    });
    return { message: "Invite resent successfully" };
};
exports.resendInvite = resendInvite;
