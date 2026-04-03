import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET!;

export interface AuthRequest extends Request {
  user? : {
    userId : string;
    role : string;
    institutionId?: string;
  };
}

export const authMiddleware = (roles: string[] = []) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const token = authHeader.split(" ")[1];

      const decoded = jwt.verify(token, JWT_SECRET) as any;

      req.user = decoded;

      if (!decoded.userId) throw new Error("Invalid token");

      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({
          message: "Forbidden"
        });
      }

      next();
    } catch (error) {
      return res.status(401).json({ message: "Invalid Token" });
    }
  };
};