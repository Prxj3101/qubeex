import { Request, Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import * as service from "./auth.service";
import { acceptInviteSchema, loginSchema } from "./auth.schema";
import { z } from "zod";

export const verifyInvite = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.query.token as string;

    if (!token) {
      res.status(400).json({ success: false, message: "Token is required" });
      return;
    }

    const data = await service.verifyInvite(token);

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const acceptInvite = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { token, password, instituteId } = acceptInviteSchema.parse(req.body);

    const data = await service.acceptInvite(token, password, instituteId);

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const forwardedFor = req.headers["x-forwarded-for"]?.toString();
    const ip =
      forwardedFor?.split(",")[0]?.trim() ||
      req.ip ||
      req.socket.remoteAddress ||
      "unknown";

    const data = await service.login(email, password, {
      ip,
      userAgent: req.headers["user-agent"] ?? "unknown",
    });

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/logout
 * Requires authentication. Blacklists the JWT so it can't be reused.
 */
export const logout = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;

    if (!user.jti) {
      res.json({ success: true, data: { message: "Logged out (stateless)" } });
      return;
    }

    // Decode the raw token to get exp
    const authHeader = req.headers.authorization!;
    const token = authHeader.split(" ")[1];
    const decoded = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString()
    );

    const data = await service.logout(user.jti, decoded.exp);

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ── PATCH /auth/profile ────────────────────────────────────────────────────
const profileSchema = z.object({
  name: z.string().min(2).max(100).trim(),
});

export const updateProfile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    const { name } = profileSchema.parse(req.body);
    const updated = await service.updateProfile(user.userId, name);
    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// ── POST /auth/change-password ─────────────────────────────────────────────
const changePwSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8)
    .regex(/[A-Z]/, "Must contain an uppercase letter")
    .regex(/[0-9]/, "Must contain a number"),
});

export const changePassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    const { currentPassword, newPassword } = changePwSchema.parse(req.body);
    await service.changePassword(user.userId, currentPassword, newPassword);
    res.json({ success: true, data: { message: "Password updated" } });
  } catch (error) {
    next(error);
  }
};
