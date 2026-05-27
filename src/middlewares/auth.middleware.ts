import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { redis } from "../utils/redis";
import type { AuthUser } from "../utils/authorization";

const JWT_SECRET = process.env.JWT_SECRET!;

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export const authMiddleware = (roles: string[] = []) => {
  return async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !/^Bearer\s[\w-]+\.[\w-]+\.[\w-]+$/.test(authHeader)) {
        res.status(401).json({ success: false, message: "Missing or malformed token" });
        return;
      }

      const token = authHeader.split(" ")[1];

      let decoded: AuthUser;
      try {
        decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
      } catch (err) {
        if (err instanceof jwt.TokenExpiredError) {
          res.status(401).json({ success: false, message: "Token expired" });
          return;
        }
        if (err instanceof jwt.JsonWebTokenError) {
          res.status(401).json({ success: false, message: "Invalid token" });
          return;
        }
        res.status(401).json({ success: false, message: "Token verification failed" });
        return;
      }

      if (!decoded.userId || !decoded.role) {
        res.status(401).json({ success: false, message: "Invalid token payload" });
        return;
      }

      if (redis && decoded.jti) {
        try {
          const isBlacklisted = await Promise.race([
            redis.get(`bl:${decoded.jti}`),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
          ]);
          if (isBlacklisted) {
            res.status(401).json({ success: false, message: "Token has been revoked" });
            return;
          }
        } catch {
        }
      }

      req.user = decoded;

      if (roles.length && !roles.includes(decoded.role)) {
        res.status(403).json({ success: false, message: "Insufficient permissions" });
        return;
      }

      next();
    } catch (error) {
      res.status(401).json({ success: false, message: "Authentication failed" });
    }
  };
};