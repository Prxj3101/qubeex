import { Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { registerPushToken, unregisterPushToken } from "../../services/pushNotification.service";

const registerSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(["ios", "android"]),
});

const unregisterSchema = z.object({
  token: z.string().min(1),
});

export const registerDevicePushToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.user!;
    const { token, platform } = registerSchema.parse(req.body);
    await registerPushToken(userId, token, platform);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const unregisterDevicePushToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { token } = unregisterSchema.parse(req.body);
    await unregisterPushToken(token);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
