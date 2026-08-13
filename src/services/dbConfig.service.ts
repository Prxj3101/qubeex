import { Client as PgClient } from "pg";
import { prisma } from "../utils/prisma";
import { logAudit } from "./audit.service";
import { encryptSecret, decryptSecret, isEncryptionConfigured } from "./crypto.service";
import { provisionTenant, evictTenantClient, invalidateConfigCache } from "./tenantDb.service";
import { BadRequestError, NotFoundError } from "../utils/errors";

export type DbEngine = "POSTGRES" | "MYSQL" | "SQLSERVER";
export type DbMode = "MANAGED" | "BYOD";

export interface DbConfigInput {
  mode: DbMode;
  engine?: DbEngine;
  host?: string;
  port?: number;
  databaseName?: string;
  username?: string;
  password?: string; // plaintext; omitted on edit = keep existing
  sslMode?: string;
  sslCaCert?: string | null;
}

interface ConnectionCreds {
  engine: DbEngine;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  password: string;
  sslMode?: string;
  sslCaCert?: string | null;
}

export interface TestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

// ── Sanitized shape returned to the frontend — never includes secrets ─────────
const toSanitized = (c: {
  mode: string;
  engine: string | null;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  username: string | null;
  passwordCipher: string | null;
  sslMode: string | null;
  sslCaCert: string | null;
  status: string;
  lastTestedAt: Date | null;
  lastError: string | null;
  provisionedAt: Date | null;
} | null) => {
  if (!c) return { mode: "MANAGED" as DbMode, status: "PENDING", hasPassword: false };
  return {
    mode: c.mode,
    engine: c.engine,
    host: c.host,
    port: c.port,
    databaseName: c.databaseName,
    username: c.username,
    hasPassword: !!c.passwordCipher,
    sslMode: c.sslMode,
    hasCaCert: !!c.sslCaCert,
    status: c.status,
    lastTestedAt: c.lastTestedAt,
    lastError: c.lastError,
    provisionedAt: c.provisionedAt,
  };
};

export const getDbConfig = async (institutionId: string) => {
  const config = await prisma.institutionDbConfig.findUnique({ where: { institutionId } });
  return toSanitized(config);
};

// ── Low-level connection test per engine ──────────────────────────────────────
async function testConnectionRaw(creds: ConnectionCreds): Promise<TestResult> {
  if (creds.engine !== "POSTGRES") {
    return { ok: false, error: `${creds.engine} connection testing is not available yet — PostgreSQL is supported first.` };
  }

  const ssl =
    creds.sslMode === "disable"
      ? false
      : {
          rejectUnauthorized: creds.sslMode === "verify-full",
          ...(creds.sslCaCert ? { ca: creds.sslCaCert } : {}),
        };

  const client = new PgClient({
    host: creds.host,
    port: creds.port,
    database: creds.databaseName,
    user: creds.username,
    password: creds.password,
    ssl,
    connectionTimeoutMillis: 8000,
    statement_timeout: 8000,
  });

  const started = Date.now();
  try {
    await client.connect();
    await client.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    // Sanitized message — never echo the credentials back.
    const message = err instanceof Error ? err.message : "Connection failed";
    return { ok: false, error: message.replace(creds.password, "***") };
  } finally {
    await client.end().catch(() => {});
  }
}

// Test a DRAFT config (from the form, before saving). Does not persist.
export const testDraftConnection = async (input: DbConfigInput): Promise<TestResult> => {
  if (input.mode !== "BYOD") return { ok: true };
  if (!input.engine || !input.host || !input.port || !input.databaseName || !input.username) {
    throw new BadRequestError("Engine, host, port, database name and username are required to test the connection");
  }
  if (!input.password) {
    throw new BadRequestError("Password is required to test a new connection");
  }
  return testConnectionRaw({
    engine: input.engine,
    host: input.host,
    port: input.port,
    databaseName: input.databaseName,
    username: input.username,
    password: input.password,
    sslMode: input.sslMode,
    sslCaCert: input.sslCaCert ?? null,
  });
};

export const saveDbConfig = async (
  institutionId: string,
  input: DbConfigInput,
  actorId?: string
) => {
  const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
  if (!institution) throw new NotFoundError("Institution not found");

  const existing = await prisma.institutionDbConfig.findUnique({ where: { institutionId } });

  // ── Managed: clear BYOD connection details, keep it simple ──────────────────
  if (input.mode === "MANAGED") {
    const saved = await prisma.institutionDbConfig.upsert({
      where: { institutionId },
      create: { institutionId, mode: "MANAGED", status: "PENDING" },
      update: {
        mode: "MANAGED",
        engine: null,
        host: null,
        port: null,
        databaseName: null,
        username: null,
        passwordCipher: null,
        passwordIv: null,
        passwordTag: null,
        sslMode: "require",
        sslCaCert: null,
        status: "PENDING",
        lastError: null,
        provisionedAt: null,
      },
    });
    logAudit("INSTITUTION_DB_CONFIG_UPDATED", {
      userId: actorId,
      actorRole: "SUPER_ADMIN",
      institutionId,
      category: "SUPERADMIN_ACTION",
      severity: "INFO",
      details: `${institution.name} set to QubeEx managed database`,
      metadata: { mode: "MANAGED" },
    });
    await invalidateConfigCache(institutionId);
    await evictTenantClient(institutionId);
    return toSanitized(saved);
  }

  // ── BYOD ────────────────────────────────────────────────────────────────────
  if (!isEncryptionConfigured()) {
    throw new BadRequestError("BYOD is not available: server encryption key (BYOD_ENC_KEY) is not configured.");
  }
  if (!input.engine || !input.host || !input.port || !input.databaseName || !input.username) {
    throw new BadRequestError("Engine, host, port, database name and username are required for BYOD");
  }

  // Password: use the provided one, else reuse the stored one (edit without re-entering).
  let passwordFields: { passwordCipher: string; passwordIv: string; passwordTag: string } | null = null;
  let plaintextForTest: string | null = null;
  if (input.password) {
    const enc = encryptSecret(input.password);
    passwordFields = { passwordCipher: enc.cipher, passwordIv: enc.iv, passwordTag: enc.tag };
    plaintextForTest = input.password;
  } else if (existing?.passwordCipher && existing.passwordIv && existing.passwordTag) {
    plaintextForTest = decryptSecret({
      cipher: existing.passwordCipher,
      iv: existing.passwordIv,
      tag: existing.passwordTag,
    });
  } else {
    throw new BadRequestError("Password is required for BYOD");
  }

  // Validate before committing status — save persists regardless, status reflects the test.
  const test = await testConnectionRaw({
    engine: input.engine,
    host: input.host,
    port: input.port,
    databaseName: input.databaseName,
    username: input.username,
    password: plaintextForTest,
    sslMode: input.sslMode,
    sslCaCert: input.sslCaCert ?? null,
  });

  const baseData = {
    mode: "BYOD",
    engine: input.engine,
    host: input.host,
    port: input.port,
    databaseName: input.databaseName,
    username: input.username,
    sslMode: input.sslMode ?? "require",
    sslCaCert: input.sslCaCert ?? null,
    status: test.ok ? "CONNECTED" : "FAILED",
    lastTestedAt: new Date(),
    lastError: test.ok ? null : test.error ?? "Connection failed",
    ...(passwordFields ?? {}),
  };

  let saved = await prisma.institutionDbConfig.upsert({
    where: { institutionId },
    create: { institutionId, ...baseData },
    update: baseData,
  });

  // Config changed — drop cached config + tenant client so the next request rebuilds.
  await invalidateConfigCache(institutionId);
  await evictTenantClient(institutionId);

  // On a successful connection, provision the academic tables in the tenant DB.
  let provisionError: string | undefined;
  if (test.ok) {
    const provision = await provisionTenant(institutionId);
    if (!provision.ok) {
      provisionError = provision.error;
      saved = await prisma.institutionDbConfig.update({
        where: { institutionId },
        data: { status: "FAILED", lastError: `Provisioning failed: ${provision.error}` },
      });
    } else {
      saved = await prisma.institutionDbConfig.findUniqueOrThrow({ where: { institutionId } });
    }
  }

  logAudit("INSTITUTION_DB_CONFIG_UPDATED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId,
    category: "SUPERADMIN_ACTION",
    severity: "WARNING",
    details: `${institution.name} BYOD database ${test.ok ? "connected" : "save failed connection test"}`,
    metadata: { mode: "BYOD", engine: input.engine, host: input.host, status: baseData.status },
  });

  return { ...toSanitized(saved), test: { ...test, ...(provisionError ? { error: provisionError, ok: false } : {}) } };
};

// Test the currently-stored config (uses decrypted stored credentials) + persist status.
export const testStoredConnection = async (institutionId: string): Promise<TestResult> => {
  const config = await prisma.institutionDbConfig.findUnique({ where: { institutionId } });
  if (!config || config.mode !== "BYOD") {
    throw new BadRequestError("Institution is not configured for BYOD");
  }
  if (!config.engine || !config.host || !config.port || !config.databaseName || !config.username || !config.passwordCipher || !config.passwordIv || !config.passwordTag) {
    throw new BadRequestError("BYOD configuration is incomplete");
  }
  const password = decryptSecret({ cipher: config.passwordCipher, iv: config.passwordIv, tag: config.passwordTag });
  const result = await testConnectionRaw({
    engine: config.engine as DbEngine,
    host: config.host,
    port: config.port,
    databaseName: config.databaseName,
    username: config.username,
    password,
    sslMode: config.sslMode ?? undefined,
    sslCaCert: config.sslCaCert,
  });
  await prisma.institutionDbConfig.update({
    where: { institutionId },
    data: {
      status: result.ok ? "CONNECTED" : "FAILED",
      lastTestedAt: new Date(),
      lastError: result.ok ? null : result.error ?? "Connection failed",
    },
  });
  return result;
};
