import rateLimit from "express-rate-limit";

// Using in-memory store for rate limiting.
// For multi-replica production deployments, swap to a Redis store using
// @upstash/redis + rate-limit-redis. For single-process (current setup) this is ideal.

const isDev = process.env.NODE_ENV !== "production";

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: isDev ? 50 : 10,     // 50 in dev, 10 in prod
  standardHeaders: true,
  legacyHeaders: false,
  validate: { default: false }, // Suppress ERR_ERL_KEY_GEN_IPV6 warning
  message: {
    success: false,
    message: "Too many login attempts. Please try again after 15 minutes.",
  },
  keyGenerator: (req) => {
    const email = (req.body?.email as string | undefined) ?? "unknown";
    const ip    = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    return `auth:${email}:${ip}`;
  },
});

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 10_000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});
