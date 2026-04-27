import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.warn("⚠️  REDIS_URL not set — rate limiting will be in-memory only");
}

export const redis = REDIS_URL
  ? new Redis(REDIS_URL, {
      maxRetriesPerRequest: null, // Queue commands until connected (required by rate-limit-redis)
      retryStrategy: (times) => Math.min(times * 500, 10_000), // Always retry, backoff to 10s max
      reconnectOnError: () => true,                             // Reconnect on any socket error
      tls: REDIS_URL.startsWith("rediss://") ? {} : undefined,
    })
  : null;

export let isRedisReady = false;

if (redis) {
  let connected = false;
  redis.on("ready", () => { isRedisReady = true; });
  redis.on("close", () => { isRedisReady = false; });
  redis.on("connect", () => {
    if (!connected) { console.log("✅  Redis connected"); connected = true; }
  });
  redis.on("error", (err) => {
    isRedisReady = false;
    const msg = err.message ?? "";
    if (!msg.includes("ECONNRESET") && !msg.includes("ENOTFOUND") && !msg.includes("Connection is closed")) {
      console.warn("⚠️  Redis:", msg);
    }
  });
}
