import { prisma } from "../../utils/prisma";
import { generateToken, hashToken } from "../../utils/token";
import { sendInviteEmail } from "../../services/email.service";
import { logAudit } from "../../services/audit.service";
import { ConflictError, NotFoundError } from "../../utils/errors";

export const createInstitutionService = async (data: any) => {
  const { name, email, type, adminName, adminEmail } = data;

  const existingInstitution = await prisma.institution.findUnique({
    where: { email },
  });

  if (existingInstitution) {
    throw new ConflictError("Institution with this email already exists");
  }

  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (existingAdmin) {
    throw new ConflictError("A user with this email already exists");
  }

  const rawToken = generateToken();
  console.log("RAW TOKEN", rawToken);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const institution = await prisma.$transaction(async (tx) => {
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

  await sendInviteEmail({
    to: adminEmail,
    inviteLink,
  });

  await logAudit("INSTITUTION_CREATED", undefined, {
    institutionId: institution.id,
    institutionName: name,
    adminEmail,
  });

  return institution;
};

export const getInstitution = async () => {
  return prisma.institution.findMany({
    include: {
      users: {
        omit: { password: true },
      },
      subscription: true,
    },
    orderBy: { createdAt: "desc" },
  });
};

export const getInstitutionById = async (id: string) => {
  const institution = await prisma.institution.findUnique({
    where: { id },
    include: {
      users: {
        omit: { password: true },
      },
      subscription: true,
    },
  });

  if (!institution) {
    throw new NotFoundError("Institution not found");
  }

  return institution;
};

export const updateInstitution = async (id: string, data: any) => {
  const existing = await prisma.institution.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Institution not found");

  return prisma.institution.update({
    where: { id },
    data,
  });
};

export const toggleInstitutionStatus = async (
  id: string,
  status: "ACTIVE" | "SUSPENDED"
) => {
  const existing = await prisma.institution.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Institution not found");

  const result = await prisma.institution.update({
    where: { id },
    data: { status },
  });

  await logAudit("INSTITUTION_STATUS_CHANGED", undefined, {
    institutionId: id,
    newStatus: status,
  });

  return result;
};

export const resendInvite = async (email: string) => {
  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    throw new NotFoundError("User not found");
  }

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.invite.create({
    data: {
      email,
      tokenHash,
      role: "ADMIN",
      institutionId: user.institutionId!,
      expiresAt,
    },
  });

  const inviteLink = `${process.env.FRONTEND_URL}/setup-password?token=${rawToken}`;

  await sendInviteEmail({
    to: user.email,
    inviteLink,
  });

  return { message: "Invite resent successfully" };
};
