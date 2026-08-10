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
        // Treat a failed lookup as "not blacklisted" rather than letting it
        // reject: the command can still be in flight after the timeout below
        // wins, and this keeps that path explicit. (Promise.race does attach
        // handlers to losers, so this isn't guarding an unhandled rejection —
        // it's making the fail-open behaviour intentional rather than incidental.)
        const blacklistLookup = redis
          .get(`bl:${decoded.jti}`)
          .catch(() => null);

        // Auth sits on every request, so a slow/unreachable Redis must never
        // block it — fail open after 500ms and let the request through.
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 500);
        });

        try {
          const isBlacklisted = await Promise.race([blacklistLookup, timeout]);
          if (isBlacklisted) {
            res.status(401).json({ success: false, message: "Token has been revoked" });
            return;
          }
        } finally {
          // Otherwise the pending timer keeps the event loop busy for 500ms
          // past every request that resolved from Redis first.
          if (timer) clearTimeout(timer);
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