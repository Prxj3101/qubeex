import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redis } from "../utils/redis";

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Please try again after 15 minutes.",
  },
  keyGenerator: (req) => {
    const email = req.body?.email || "unknown";
    const ip = req.ip || "unknown";
    return `auth:${email}:${ip}`;
  },
  ...(redis
    ? {
        store: new RedisStore({
          // @ts-expect-error - ioredis sendCommand is compatible
          sendCommand: (...args: string[]) => redis.call(...args),
        }),
      }
    : {}),
});

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
  ...(redis
    ? {
        store: new RedisStore({
          // @ts-expect-error - ioredis sendCommand is compatible
          sendCommand: (...args: string[]) => redis.call(...args),
        }),
      }
    : {}),
});
