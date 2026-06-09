import express from "express";
import helmet from "helmet";
import cors from "cors";
import superadminRoutes from "./modules/superadmin/superadmin.routes";
import authRoutes from "./modules/auth/auth.routes";
import adminRoutes from "./modules/admin/admin.routes";
import staffroomRoutes from "./modules/staffroom/staffroom.routes";
import teacherStaffroomRoutes from "./modules/staffroom/staffroom.teacher.routes";
import campusRoutes from "./modules/campus/campus.routes";
import teacherCampusRoutes from "./modules/campus/campus.teacher.routes";
import teacherRoutes from "./modules/teacher/teacher.routes";
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

const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200,
};

// Handle preflight requests for all routes
app.options("/{*path}", cors(corsOptions));
app.use(cors(corsOptions));

app.use(express.json({ limit: "10kb" }));

app.use(generalLimiter);

app.use("/api/superadmin", superadminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/staffroom", staffroomRoutes);
app.use("/api/admin/campus", campusRoutes);
app.use("/api/teacher/campus", teacherCampusRoutes);
app.use("/api/teacher/staffroom", teacherStaffroomRoutes);
app.use("/api/teacher", teacherRoutes);

app.get("/", (_req, res) => {
  res.send("Server is running...");
});

// Connection status tracked at startup — health check returns instantly
export const connectionStatus = { db: false, redis: false };

app.get("/health", (_req, res) => {
  res.status(connectionStatus.db ? 200 : 503).json({
    status: connectionStatus.db ? "ok" : "degraded",
    db: { status: connectionStatus.db ? "ok" : "down" },
    redis: { status: connectionStatus.redis ? "ok" : "down" },
    timestamp: new Date().toISOString(),
  });
});

app.use(errorHandler);

export default app;
