"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const redis_1 = require("../utils/redis");
const JWT_SECRET = process.env.JWT_SECRET;
const authMiddleware = (roles = []) => {
    return async (req, res, next) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !/^Bearer\s[\w-]+\.[\w-]+\.[\w-]+$/.test(authHeader)) {
                res.status(401).json({ success: false, message: "Missing or malformed token" });
                return;
            }
            const token = authHeader.split(" ")[1];
            let decoded;
            try {
                decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            }
            catch (err) {
                if (err instanceof jsonwebtoken_1.default.TokenExpiredError) {
                    res.status(401).json({ success: false, message: "Token expired" });
                    return;
                }
                if (err instanceof jsonwebtoken_1.default.JsonWebTokenError) {
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
            if (redis_1.redis && decoded.jti) {
                try {
                    // Timeout after 500ms — if Redis is reconnecting, fail open rather than hang
                    const isBlacklisted = await Promise.race([
                        redis_1.redis.get(`bl:${decoded.jti}`),
                        new Promise((resolve) => setTimeout(() => resolve(null), 500)),
                    ]);
                    if (isBlacklisted) {
                        res.status(401).json({ success: false, message: "Token has been revoked" });
                        return;
                    }
                }
                catch {
                    // Redis unavailable — allow request through (fail open)
                }
            }
            req.user = decoded;
            if (roles.length && !roles.includes(decoded.role)) {
                res.status(403).json({ success: false, message: "Insufficient permissions" });
                return;
            }
            next();
        }
        catch (error) {
            res.status(401).json({ success: false, message: "Authentication failed" });
        }
    };
};
exports.authMiddleware = authMiddleware;
