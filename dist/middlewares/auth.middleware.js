"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET;
const authMiddleware = (roles = []) => {
    return (req, res, next) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader)
                throw new Error("Unauthorized");
            const token = authHeader.split(" ")[1];
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            if (roles.length && !roles.includes(decoded.role)) {
                throw new Error("Forbidden");
            }
            req.user = decoded;
            next();
        }
        catch (e) {
            res.status(401).json({ success: false, message: e.message });
        }
    };
};
exports.authMiddleware = authMiddleware;
