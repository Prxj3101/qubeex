import express from "express";
import helmet from "helmet";
import cors from "cors";
import superadminRoutes from "./modules/superadmin/superadmin.routes";
import authRoutes from "./modules/auth/auth.routes";
import adminRoutes from "./modules/admin/admin.routes";
import staffroomRoutes from "./modules/staffroom/staffroom.routes";
import campusRoutes from "./modules/campus/campus.routes";
import teacherCampusRoutes from "./modules/campus/campus.teacher.routes";
import { errorHandler } from "./middlewares/errorHandler.middleware";
import { generalLimiter } from "./middlewares/rateLimiter.middleware";
import { prisma } from "./utils/prisma";
import { redis } from "./utils/redis";

const app = express();

app.set("trust proxy", 1);

app.use(helmet());

const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000,http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim());

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10kb" }));

app.use(generalLimiter);

app.use("/api/superadmin", superadminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/staffroom", staffroomRoutes);
app.use("/api/admin/campus", campusRoutes);
app.use("/api/teacher/campus", teacherCampusRoutes);

app.get("/", (_req, res) => {
  res.send("Server is running...");
});

app.get("/health", async (_req, res) => {
  const dbStart = Date.now();
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {}
  const dbLatency = Date.now() - dbStart;

  const redisStart = Date.now();
  let redisOk = false;
  try {
    if (redis) { await redis.ping(); redisOk = true; }
  } catch {}
  const redisLatency = Date.now() - redisStart;

  const status = dbOk ? "ok" : "degraded";
  res.status(dbOk ? 200 : 503).json({
    status,
    db:    { status: dbOk    ? "ok" : "down", latency: `${dbLatency}ms` },
    redis: {
      status: redisOk ? "ok" : redis ? "down" : "not_configured",
      latency: redisOk ? `${redisLatency}ms` : null,
    },
    timestamp: new Date().toISOString(),
  });
});

app.use(errorHandler);

export default app;
