import { prisma } from "../../utils/prisma";
import { redis, isRedisReady } from "../../utils/redis";
import { hashToken } from "../../utils/token";
import { logAudit } from "../../services/audit.service";
import { UnauthorizedError, BadRequestError } from "../../utils/errors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET!;
const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = "7d";

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

  logAudit("INVITE_ACCEPTED", {
    userId: result.id,
    institutionId: result.institutionId ?? undefined,
    details: `Invite accepted by ${result.email}`,
    metadata: { email: result.email },
    category: "SECURITY",
    severity: "INFO",
  });

  // Activate the institution if it was PENDING
  if (result.institutionId) {
    await prisma.institution.update({
      where: { id: result.institutionId },
      data: { status: "ACTIVE" },
    });
  }

  // After transaction, fetch permissions if SUB_ADMIN:
  let permissions: string[] | undefined;
  if (result.role === 'SUB_ADMIN') {
    try {
      const subAdmin = await prisma.subAdmin.findUnique({
        where: { userId: result.id },
        select: { permissions: true },
      });
      permissions = subAdmin?.permissions ?? [];
    } catch {
      permissions = [];
    }
  }

  const jti = crypto.randomUUID();
  const accessToken = jwt.sign(
    {
      userId: result.id,
      role: result.role,
      institutionId: result.institutionId,
      permissions,
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

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_SECS  = 15 * 60; // 15 min

async function checkLoginLockout(email: string) {
  if (!redis || !isRedisReady) return;
  const attempts = parseInt((await redis.get(`loginAttempts:${email}`)) ?? "0", 10);
  if (attempts >= LOGIN_MAX_ATTEMPTS) {
    const ttl = await redis.ttl(`loginAttempts:${email}`);
    const mins = Math.ceil(ttl / 60);
    throw new UnauthorizedError(
      `Account temporarily locked. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`
    );
  }
}

async function recordFailedAttempt(email: string) {
  if (!redis || !isRedisReady) return;
  const key = `loginAttempts:${email}`;
  const attempts = await redis.incr(key);
  if (attempts === 1) {
    await redis.expire(key, LOGIN_WINDOW_SECS);
  }
}

async function clearLoginAttempts(email: string) {
  if (!redis || !isRedisReady) return;
  await redis.del(`loginAttempts:${email}`);
}

export const login = async (email: string, password: string, context: LoginContext = {}) => {
  await checkLoginLockout(email);

  const user = await prisma.user.findUnique({
    where: { email },
    include: { subAdmin: true },
  });

  if (!user || !user.password) {
    await recordFailedAttempt(email);
    throw new UnauthorizedError("Invalid credentials");
  }

  if (!user.isActive) {
    throw new UnauthorizedError("Invalid credentials");
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    await recordFailedAttempt(email);
    logAudit("LOGIN_FAILED", {
      userId: user.id,
      actorRole: user.role,
      institutionId: user.institutionId ?? undefined,
      ip: context.ip,
      details: `Failed login attempt for ${email}`,
      metadata: { email, userAgent: context.userAgent },
      category: "SECURITY",
      severity: "WARNING",
    });
    throw new UnauthorizedError("Invalid credentials");
  }

  await clearLoginAttempts(email);

  logAudit("LOGIN_SUCCESS", {
    userId: user.id,
    actorRole: user.role,
    institutionId: user.institutionId ?? undefined,
    ip: context.ip,
    details: `Login by ${email}`,
    metadata: { email, userAgent: context.userAgent },
    category: "SECURITY",
    severity: "INFO",
  });

  const permissions = user.role === 'SUB_ADMIN' && user.subAdmin
    ? user.subAdmin.permissions
    : undefined;

  const jti = crypto.randomUUID();
  const token = jwt.sign(
    {
      userId: user.id,
      role: user.role,
      institutionId: user.institutionId,
      permissions,
      jti,
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );

  let institutionStatus: string | null = null;
  let subscriptionStatus: string | null = null;
  if (user.institutionId) {
    const sub = await prisma.subscription.findUnique({
      where: { institutionId: user.institutionId },
      select: { status: true },
    });
    subscriptionStatus = sub?.status ?? null;
    const inst = await prisma.institution.findUnique({
      where: { id: user.institutionId },
      select: { status: true },
    });
    institutionStatus = inst?.status ?? null;
  }

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      institutionId: user.institutionId,
      permissions,
      createdAt: user.createdAt,
      mustChangePassword: user.mustChangePassword,
    },
    institution: user.institutionId
      ? { status: institutionStatus, subscriptionStatus }
      : null,
  };
};

export const logout = async (jti: string, exp: number) => {
  if (!redis || !isRedisReady) {
    return { message: "Logged out (stateless)" };
  }

  const ttl = Math.max(exp - Math.floor(Date.now() / 1000), 0);

  await redis.setex(`bl:${jti}`, ttl, "1");

  return { message: "Logged out successfully" };
};

// ── PATCH /auth/profile ────────────────────────────────────────────────────
export const updateProfile = async (userId: string, name: string) => {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { name },
    omit: { password: true },
  });

  logAudit("PROFILE_UPDATED", {
    userId: updated.id,
    actorRole: updated.role,
    institutionId: updated.institutionId ?? undefined,
    details: `Display name updated to "${name}"`,
    category: "SECURITY",
    severity: "INFO",
  });

  return {
    id: updated.id,
    name: updated.name,
    email: updated.email,
    role: updated.role,
    institutionId: updated.institutionId,
  };
};

// ── POST /auth/change-password ─────────────────────────────────────────────
export const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string
) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.password) {
    throw new UnauthorizedError("Invalid credentials");
  }

  const isMatch = await bcrypt.compare(currentPassword, user.password);
  if (!isMatch) {
    throw new UnauthorizedError("Current password is incorrect");
  }

  const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await prisma.user.update({ where: { id: userId }, data: { password: hashed } });

  logAudit("PASSWORD_CHANGED", {
    userId: user.id,
    actorRole: user.role,
    institutionId: user.institutionId ?? undefined,
    details: "Password changed by user",
    category: "SECURITY",
    severity: "WARNING",
  });

  return { message: "Password updated successfully" };
};
