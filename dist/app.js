"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const cors_1 = __importDefault(require("cors"));
const superadmin_routes_1 = __importDefault(require("./modules/superadmin/superadmin.routes"));
const auth_routes_1 = __importDefault(require("./modules/auth/auth.routes"));
const admin_routes_1 = __importDefault(require("./modules/admin/admin.routes"));
const errorHandler_middleware_1 = require("./middlewares/errorHandler.middleware");
const rateLimiter_middleware_1 = require("./middlewares/rateLimiter.middleware");
const prisma_1 = require("./utils/prisma");
const redis_1 = require("./utils/redis");
const app = (0, express_1.default)();
app.set("trust proxy", 1);
app.use((0, helmet_1.default)());
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000,http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim());
app.use((0, cors_1.default)({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express_1.default.json({ limit: "10kb" }));
app.use(rateLimiter_middleware_1.generalLimiter);
app.use("/api/superadmin", superadmin_routes_1.default);
app.use("/api/auth", auth_routes_1.default);
app.use("/api/admin", admin_routes_1.default);
app.get("/", (_req, res) => {
    res.send("Server is running...");
});
app.get("/health", async (_req, res) => {
    const dbStart = Date.now();
    let dbOk = false;
    try {
        await prisma_1.prisma.$queryRaw `SELECT 1`;
        dbOk = true;
    }
    catch { }
    const dbLatency = Date.now() - dbStart;
    const redisStart = Date.now();
    let redisOk = false;
    try {
        if (redis_1.redis) {
            await redis_1.redis.ping();
            redisOk = true;
        }
    }
    catch { }
    const redisLatency = Date.now() - redisStart;
    const status = dbOk ? "ok" : "degraded";
    res.status(dbOk ? 200 : 503).json({
        status,
        db: { status: dbOk ? "ok" : "down", latency: `${dbLatency}ms` },
        redis: {
            status: redisOk ? "ok" : redis_1.redis ? "down" : "not_configured",
            latency: redisOk ? `${redisLatency}ms` : null,
        },
        timestamp: new Date().toISOString(),
    });
});
app.use(errorHandler_middleware_1.errorHandler);
exports.default = app;
