import { Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { emailSchema, passwordSchema } from "../auth/auth.schema";
import {
  getUserProfile,
  updateUserProfile,
  changeUserPassword,
  getUserLoginActivity,
} from "../../services/profile.service";

// Shared account-settings handlers used by admin, sub-admin and teacher routes.
// They always act on the authenticated user (req.user.userId).

const updateProfileSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(200).trim(),
  email: emailSchema,
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, "Current password is required").max(100),
  newPassword: passwordSchema,
});

export const getProfile = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await getUserProfile(req.user!.userId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updateProfile = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = updateProfileSchema.parse(req.body);
    const result = await updateUserProfile(req.user!.userId, data);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const changePassword = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = changePasswordSchema.parse(req.body);
    const result = await changeUserPassword(req.user!.userId, data);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getLoginActivity = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const data = await getUserLoginActivity(req.user!.userId, limit);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
