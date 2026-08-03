import bcrypt from "bcrypt";
import { prisma } from "../utils/prisma";
import { logAudit } from "./audit.service";
import {
  NotFoundError,
  BadRequestError,
  ConflictError,
  UnauthorizedError,
} from "../utils/errors";

const BCRYPT_ROUNDS = 12;

// Best-effort human-readable device name from a User-Agent string.
const getDeviceName = (userAgent?: string | null): string => {
  if (!userAgent) return "Unknown device";
  const browser = userAgent.includes("Edg/")
    ? "Edge"
    : userAgent.includes("Chrome/")
    ? "Chrome"
    : userAgent.includes("Safari/") && !userAgent.includes("Chrome/")
    ? "Safari"
    : userAgent.includes("Firefox/")
    ? "Firefox"
    : userAgent.includes("OPR/") || userAgent.includes("Opera/")
    ? "Opera"
    : "Browser";

  const os = /iPhone|iPad|iPod/.test(userAgent)
    ? "iOS"
    : userAgent.includes("Android")
    ? "Android"
    : userAgent.includes("Windows")
    ? "Windows"
    : userAgent.includes("Mac OS X") || userAgent.includes("Macintosh")
    ? "macOS"
    : userAgent.includes("Linux")
    ? "Linux"
    : "Unknown OS";

  return `${browser} on ${os}`;
};

const toProfileResponse = (user: {
  id: string;
  name: string | null;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  isActive: user.isActive,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

// ── Role-agnostic account settings (used by admin, sub-admin and teacher) ──────

export const getUserProfile = async (userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("Profile not found");
  return toProfileResponse(user);
};

export const updateUserProfile = async (
  userId: string,
  data: { name: string; email: string }
) => {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) throw new NotFoundError("Profile not found");

  if (data.email !== existing.email) {
    const emailOwner = await prisma.user.findUnique({ where: { email: data.email } });
    if (emailOwner && emailOwner.id !== userId) {
      throw new ConflictError("A user with this email already exists");
    }
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { name: data.name, email: data.email },
  });

  logAudit("PROFILE_UPDATED", {
    userId,
    actorRole: existing.role,
    institutionId: existing.institutionId ?? undefined,
    category: "SECURITY",
    severity: "INFO",
    details: `Profile updated for ${user.email}`,
    metadata: { email: user.email },
  });

  return toProfileResponse(user);
};

export const changeUserPassword = async (
  userId: string,
  data: { oldPassword: string; newPassword: string }
) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("Profile not found");
  if (!user.password) throw new BadRequestError("Password is not set for this account");

  const isMatch = await bcrypt.compare(data.oldPassword, user.password);
  if (!isMatch) throw new UnauthorizedError("Current password is incorrect");

  const isSamePassword = await bcrypt.compare(data.newPassword, user.password);
  if (isSamePassword) throw new BadRequestError("New password must be different from current password");

  const hashedPassword = await bcrypt.hash(data.newPassword, BCRYPT_ROUNDS);
  await prisma.user.update({ where: { id: userId }, data: { password: hashedPassword } });

  logAudit("PASSWORD_CHANGED", {
    userId,
    actorRole: user.role,
    institutionId: user.institutionId ?? undefined,
    category: "SECURITY",
    severity: "WARNING",
    details: `Password changed for ${user.email}`,
    metadata: { email: user.email },
  });

  return { message: "Password changed successfully" };
};

export const getUserLoginActivity = async (userId: string, limit = 10) => {
  const logs = await prisma.auditLog.findMany({
    where: { action: "LOGIN_SUCCESS", userId },
    take: Math.min(Math.max(limit, 1), 30),
    orderBy: { createdAt: "desc" },
  });

  return logs.map((log, index) => {
    const metadata = log.metadata as { userAgent?: string | null } | null;
    return {
      id: log.id,
      device: getDeviceName(metadata?.userAgent),
      ip: log.ip ?? "unknown",
      location: "Captured by server",
      time: log.createdAt,
      latest: index === 0,
      userAgent: metadata?.userAgent ?? null,
    };
  });
};
