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
import promotionTeacherRoutes from "./modules/promotion/promotion.teacher.routes";
import teacherRoutes from "./modules/teacher/teacher.routes";
import studentRoutes from "./modules/student/student.routes";
import { razorpayWebhookHandler } from "./modules/webhooks/razorpay.webhook";
import quizRoutes from "./modules/quiz/quiz.routes";
import brandingRoutes from "./modules/branding/branding.routes";
import publicRoutes from "./modules/public/public.routes";
import { errorHandler } from "./middlewares/errorHandler.middleware";
import { generalLimiter } from "./middlewares/rateLimiter.middleware";
import { prisma } from "./utils/prisma";
import { redis } from "./utils/redis";
import { recordApiRequest } from "./services/systemHealth.service";

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
  // Custom response headers aren't visible to frontend JS across origins by
  // default — X-Pdf-Normalize-Status (Blackboard PDF normalization result)
  // needs to be explicitly exposed for the frontend to read it.
  exposedHeaders: ["X-Pdf-Normalize-Status"],
  optionsSuccessStatus: 200,
};

// Handle preflight requests for all routes
app.options("/{*path}", cors(corsOptions));
app.use(cors(corsOptions));

// Razorpay webhook — must be before express.json() to receive raw body
app.post(
  "/api/webhooks/razorpay",
  express.raw({ type: "application/json" }),
  razorpayWebhookHandler
);

// Staff attendance: a month of machine punches / a whole staff day can be bigger than 10kb.
app.use("/api/admin/payroll/attendance/import", express.json({ limit: "5mb" }));
app.use("/api/admin/payroll/attendance/day", express.json({ limit: "512kb" }));

app.use(express.json({ limit: "10kb" }));

app.use(generalLimiter);

// Records every request's duration + whether it errored, for the superadmin
// System Health page's response-time and error-rate charts.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    recordApiRequest(Date.now() - start, res.statusCode >= 500);
  });
  next();
});

app.use("/api/superadmin", superadminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/staffroom", staffroomRoutes);
app.use("/api/admin/campus", campusRoutes);
app.use("/api/teacher/campus", teacherCampusRoutes);
app.use("/api/teacher/staffroom", teacherStaffroomRoutes);
app.use("/api/teacher", teacherRoutes);
app.use("/api/student", studentRoutes);
app.use("/api/quiz", quizRoutes);
app.use("/api/branding", brandingRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/teacher/promotions", promotionTeacherRoutes);

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

// ── Public share link — no auth ───────────────────────────────────────────────
app.get("/share/marksheet/:token", async (req, res, next) => {
  try {
    const token = req.params.token as string;
    const marksheet = await prisma.marksheet.findUnique({
      where: { shareToken: token },
      select: { pdfR2Key: true, status: true },
    });
    if (!marksheet || marksheet.status !== "PUBLISHED" || !marksheet.pdfR2Key) {
      res.status(404).json({ success: false, error: "Marksheet not found or not yet published" });
      return;
    }
    const publicUrl = `${process.env.R2_PUBLIC_URL!.replace(/\/$/, "")}/${marksheet.pdfR2Key}`;
    res.redirect(302, publicUrl);
  } catch (err) {
    next(err);
  }
});

app.use(errorHandler);

export default app;
