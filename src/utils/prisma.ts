import "dotenv/config";

import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
});

const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === "production" ? ["error"] : ["query", "error", "warn"],
  // Per-call $transaction({ timeout }) overrides are unreliable on their own
  // (see https://github.com/prisma/prisma/issues/26980 — silently falls back
  // to the 5s default). Setting it here too is the documented workaround.
  transactionOptions: { timeout: 60_000, maxWait: 10_000 },
});