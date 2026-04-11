import { Request, Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import * as service from "./auth.service";
import { acceptInviteSchema, loginSchema } from "./auth.schema";

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
    const { token, password } = acceptInviteSchema.parse(req.body);

    const data = await service.acceptInvite(token, password);

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

    const data = await service.login(email, password);

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