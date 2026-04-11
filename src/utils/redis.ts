import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.warn("REDIS_URL not set — rate limiting and JWT blacklist will be unavailable");
}

export const redis = REDIS_URL
  ? new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 200, 2000);
        return delay;
      },
      tls: REDIS_URL.startsWith("rediss://") ? {} : undefined,
    })
  : null;

if (redis) {
  redis.on("connect", () => console.log("Redis connected"));
  redis.on("error", (err) => console.error("Redis error:", err.message));
}
