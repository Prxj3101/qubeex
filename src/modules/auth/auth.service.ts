import { prisma } from "../../utils/prisma";
import { redis } from "../../utils/redis";
import { hashToken } from "../../utils/token";
import { logAudit } from "../../services/audit.service";
import { UnauthorizedError, BadRequestError } from "../../utils/errors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET!;
const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = "1h";

export const verifyInvite = async (token: string) => {
  const tokenHash = hashToken(token);

  const invite = await prisma.invite.findUnique({
    where: { tokenHash },
    include: { institution: true },
  });

  if (!invite) throw new BadRequestError("Invalid or expired invite");
  if (invite.isUsed) throw new BadRequestError("Invalid or expired invite");
  if (invite.expiresAt < new Date()) {
    throw new BadRequestError("Invalid or expired invite");
  }

  // Look up the admin user's name
  const adminUser = await prisma.user.findUnique({ where: { email: invite.email } });

  return {
    valid: true,
    email: invite.email,
    institutionName: invite.institution.name,
    institutionCode: invite.institution.institutionCode,
    adminName: adminUser?.name ?? "",
    institution: invite.institution.name,
  };
};

export const acceptInvite = async (token: string, password: string, instituteId: string) => {
  const tokenHash = hashToken(token);

  const invite = await prisma.invite.findUnique({
    where: { tokenHash },
    include: { institution: true },
  });

  if (!invite) throw new BadRequestError("Invalid or expired invite");
  if (invite.isUsed) throw new BadRequestError("Invalid or expired invite");
  if (invite.expiresAt < new Date()) {
    throw new BadRequestError("Invalid or expired invite");
  }

  // Validate the institution code submitted by the admin matches
  if (invite.institution.institutionCode !== instituteId?.trim()) {
    throw new BadRequestError("Invalid Institution ID");
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = await prisma.user.findUnique({
    where: { email: invite.email },
  });

  if (!user) throw new BadRequestError("Invalid or expired invite");

  const result = await prisma.$transaction(async (tx) => {
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

  await logAudit("INVITE_ACCEPTED", {
    userId: result.id,
    institutionId: result.institutionId ?? undefined,
    details: `Invite accepted by ${result.email}`,
    metadata: { email: result.email },
  });

  // Activate the institution if it was PENDING
  if (result.institutionId) {
    await prisma.institution.update({
      where: { id: result.institutionId },
      data: { status: "ACTIVE" },
    });
  }

  const jti = crypto.randomUUID();
  const accessToken = jwt.sign(
    {
      userId: result.id,
      role: result.role,
      institutionId: result.institutionId,
      jti,
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );

  return { token: accessToken };
};

type LoginContext = {
  ip?: string;
  userAgent?: string;
};

export const login = async (email: string, password: string, context: LoginContext = {}) => {
  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user || !user.password) {
    throw new UnauthorizedError("Invalid credentials");
  }

  if (!user.isActive) {
    throw new UnauthorizedError("Invalid credentials");
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    await logAudit("LOGIN_FAILED", {
      userId: user.id,
      actorRole: user.role,
      institutionId: user.institutionId ?? undefined,
      ip: context.ip,
      details: `Failed login attempt for ${email}`,
      metadata: { email, userAgent: context.userAgent },
    });
    throw new UnauthorizedError("Invalid credentials");
  }

  await logAudit("LOGIN_SUCCESS", {
    userId: user.id,
    actorRole: user.role,
    institutionId: user.institutionId ?? undefined,
    ip: context.ip,
    details: `Login by ${email}`,
    metadata: { email, userAgent: context.userAgent },
  });

  const jti = crypto.randomUUID();
  const token = jwt.sign(
    {
      userId: user.id,
      role: user.role,
      institutionId: user.institutionId,
      jti,
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );

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

export const logout = async (jti: string, exp: number) => {
  if (!redis) {
    return { message: "Logged out (stateless)" };
  }

  const ttl = Math.max(exp - Math.floor(Date.now() / 1000), 0);

  await redis.setex(`bl:${jti}`, ttl, "1");

  return { message: "Logged out successfully" };
};
