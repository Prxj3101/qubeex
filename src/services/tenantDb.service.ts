import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient as TenantPrisma } from "../generated/tenant-pg/client";
import { prisma } from "../utils/prisma";
import { decryptSecret } from "./crypto.service";
import { getCache, setCache, delCache } from "../utils/cache";
import type { AcademicClient } from "../utils/academicContext";
import type { InstitutionDbConfig } from "../generated/prisma/client";

// Thrown when a BYOD institution's database can't be used right now. Carries a
// stable code so the routing middleware can return a scoped 503.
export class ByodUnavailableError extends Error {
  readonly code = "INSTITUTION_DB_UNAVAILABLE";
  constructor(public readonly institutionId: string, message = "Institution database is unavailable") {
    super(message);
    this.name = "ByodUnavailableError";
  }
}

interface CachedClient {
  client: TenantPrisma;
  pool: Pool;
  createdAt: number;
}

const TTL_MS = 30 * 60 * 1000; // recycle a tenant client every 30 min
const cache = new Map<string, CachedClient>();

function buildTenantClient(cfg: InstitutionDbConfig): CachedClient {
  if (!cfg.host || !cfg.port || !cfg.databaseName || !cfg.username || !cfg.passwordCipher || !cfg.passwordIv || !cfg.passwordTag) {
    throw new ByodUnavailableError(cfg.institutionId, "BYOD configuration is incomplete");
  }
  const password = decryptSecret({ cipher: cfg.passwordCipher, iv: cfg.passwordIv, tag: cfg.passwordTag });
  const ssl =
    cfg.sslMode === "disable"
      ? false
      : { rejectUnauthorized: cfg.sslMode === "verify-full", ...(cfg.sslCaCert ? { ca: cfg.sslCaCert } : {}) };

  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.databaseName,
    user: cfg.username,
    password,
    ssl,
    max: 5,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
  });
  const adapter = new PrismaPg(pool);
  // transactionOptions mirrors src/utils/prisma.ts — per-call $transaction({
  // timeout }) overrides alone are unreliable (prisma/prisma#26980).
  const client = new TenantPrisma({ adapter, transactionOptions: { timeout: 60_000, maxWait: 10_000 } });
  return { client, pool, createdAt: Date.now() };
}

function getOrCreateTenantClient(cfg: InstitutionDbConfig): TenantPrisma {
  const existing = cache.get(cfg.institutionId);
  if (existing && Date.now() - existing.createdAt < TTL_MS) return existing.client;
  if (existing) {
    void existing.client.$disconnect().catch(() => {});
    void existing.pool.end().catch(() => {});
    cache.delete(cfg.institutionId);
  }
  const created = buildTenantClient(cfg);
  cache.set(cfg.institutionId, created);
  return created.client;
}

/**
 * Resolve the academic client for an institution.
 * - Managed (or unconfigured) → the central `prisma` client. This is the core
 *   invariant: institutions without an active BYOD config behave exactly as today.
 * - BYOD + CONNECTED (Postgres) → a cached per-institution tenant client.
 * - BYOD but not connected / unsupported engine → throws ByodUnavailableError.
 */
const CFG_TTL_SECONDS = 60;
const cfgKey = (institutionId: string) => `byod:cfg:${institutionId}`;

// Cached config lookup. Resilient: any failure (incl. the table not existing yet)
// is treated as "managed", so mounting the router can never break academic requests.
async function loadConfig(institutionId: string): Promise<InstitutionDbConfig | null> {
  const wrapped = await getCache<{ config: InstitutionDbConfig | null }>(cfgKey(institutionId));
  if (wrapped) return wrapped.config;
  let cfg: InstitutionDbConfig | null = null;
  try {
    cfg = await prisma.institutionDbConfig.findUnique({ where: { institutionId } });
  } catch {
    cfg = null; // e.g. migration not applied — fall back to managed
  }
  await setCache(cfgKey(institutionId), { config: cfg }, CFG_TTL_SECONDS);
  return cfg;
}

/** Invalidate the cached BYOD config for an institution (after a config change). */
export async function invalidateConfigCache(institutionId: string): Promise<void> {
  await delCache(cfgKey(institutionId));
}

export async function getAcademicClient(institutionId: string): Promise<AcademicClient> {
  const cfg = await loadConfig(institutionId);
  if (!cfg || cfg.mode !== "BYOD") return prisma as AcademicClient; // managed → central

  if (cfg.engine !== "POSTGRES") {
    throw new ByodUnavailableError(institutionId, `${cfg.engine ?? "This"} engine is not supported yet`);
  }
  // Return the tenant client handle for any complete config (pg connects lazily,
  // so this never blocks platform routes). A genuinely-down tenant DB surfaces only
  // when an academic query actually runs. `status` remains advisory for the UI.
  try {
    return getOrCreateTenantClient(cfg) as unknown as AcademicClient;
  } catch (err) {
    if (err instanceof ByodUnavailableError) throw err;
    throw new ByodUnavailableError(institutionId, err instanceof Error ? err.message : "Failed to open institution database");
  }
}

/** Drop a cached tenant client (call after its config changes). */
export async function evictTenantClient(institutionId: string): Promise<void> {
  const existing = cache.get(institutionId);
  if (!existing) return;
  cache.delete(institutionId);
  await existing.client.$disconnect().catch(() => {});
  await existing.pool.end().catch(() => {});
}

// Raw pg Pool options from a config (used for provisioning DDL execution).
function tenantPoolOptions(cfg: InstitutionDbConfig) {
  if (!cfg.host || !cfg.port || !cfg.databaseName || !cfg.username || !cfg.passwordCipher || !cfg.passwordIv || !cfg.passwordTag) {
    throw new ByodUnavailableError(cfg.institutionId, "BYOD configuration is incomplete");
  }
  const password = decryptSecret({ cipher: cfg.passwordCipher, iv: cfg.passwordIv, tag: cfg.passwordTag });
  const ssl =
    cfg.sslMode === "disable"
      ? false
      : { rejectUnauthorized: cfg.sslMode === "verify-full", ...(cfg.sslCaCert ? { ca: cfg.sslCaCert } : {}) };
  return { host: cfg.host, port: cfg.port, database: cfg.databaseName, user: cfg.username, password, ssl };
}

/**
 * Create the academic tables in the institution's own database by executing the
 * generated DDL (prisma/tenant/init.sql). Idempotent: skips if already provisioned.
 * Sets `provisionedAt` on success. Postgres-only.
 */
export async function provisionTenant(institutionId: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await prisma.institutionDbConfig.findUnique({ where: { institutionId } });
  if (!cfg || cfg.mode !== "BYOD") return { ok: false, error: "Institution is not on BYOD" };
  if (cfg.engine !== "POSTGRES") return { ok: false, error: `${cfg.engine ?? "This"} engine is not supported yet` };
  if (cfg.provisionedAt) return { ok: true }; // already provisioned

  let ddl: string;
  try {
    ddl = fs.readFileSync(path.join(process.cwd(), "prisma", "tenant", "init.sql"), "utf8");
  } catch {
    return { ok: false, error: "Tenant schema DDL (prisma/tenant/init.sql) is missing" };
  }

  const pool = new Pool({ ...tenantPoolOptions(cfg), max: 2, connectionTimeoutMillis: 10000 });
  try {
    await pool.query(ddl); // pg runs the multi-statement DDL as one batch
    await prisma.institutionDbConfig.update({ where: { institutionId }, data: { provisionedAt: new Date() } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Provisioning failed" };
  } finally {
    await pool.end().catch(() => {});
  }
}
