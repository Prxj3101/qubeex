import express from "express";
import helmet from "helmet";
import cors from "cors";
import superadminRoutes from "./modules/superadmin/superadmin.routes";
import authRoutes from "./modules/auth/auth.routes";
import adminRoutes from "./modules/admin/admin.routes";
import { errorHandler } from "./middlewares/errorHandler.middleware";
import { generalLimiter } from "./middlewares/rateLimiter.middleware";

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

app.get("/", (_req, res) => {
  res.send("Server is running...");
});

app.use(errorHandler);

export default app;
