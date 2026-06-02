import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redis, isRedisReady } from "../utils/redis";

const isDev = process.env.NODE_ENV !== "production";

const makeStore = (prefix: string) =>
  redis && !isDev && isRedisReady
    ? new RedisStore({
        prefix,
        sendCommand: (...args: string[]) =>
          (redis as any).call(...(args as [string, ...string[]])),
      })
    : undefined;

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 50 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("rl:auth:"),
  validate: { default: false },
  message: {
    success: false,
    message: "Too many login attempts. Please try again after 15 minutes.",
  },
  keyGenerator: (req) => {
    const email = (req.body?.email as string | undefined) ?? "unknown";
    const ip    = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    return `${email}:${ip}`;
  },
});

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 10_000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("rl:general:"),
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});
