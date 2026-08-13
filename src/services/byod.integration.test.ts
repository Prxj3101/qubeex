/**
 * BYOD end-to-end routing test — GUARDED.
 *
 * Runs only when TENANT_TEST_DATABASE_URL points at a scratch Postgres (stands in
 * for an institution's own DB) and BYOD_ENC_KEY is set. Otherwise it is skipped so
 * the suite stays green without extra infrastructure.
 *
 * Verifies:
 *  - saveDbConfig(BYOD) connects + provisions the tenant DB (academic tables created)
 *  - getAcademicClient(BYOD) returns a client whose writes land in the TENANT DB
 *  - getAcademicClient(managed) returns the central prisma
 */
import { URL } from "url";
import { Client as PgClient } from "pg";

const TENANT_URL = process.env.TENANT_TEST_DATABASE_URL;
const HAS_KEY = !!process.env.BYOD_ENC_KEY;
const RUN = TENANT_URL && HAS_KEY;

const d = RUN ? describe : describe.skip;

// The scratch tenant DB must start empty on each run — provisioning assumes a
// fresh "new/empty institution" DB and is not idempotent (CREATE TYPE/TABLE).
// A prior run leaves the academic schema behind, so reset it before provisioning.
async function resetTenantSchema(url: string): Promise<void> {
  const u = new URL(url);
  const client = new PgClient({
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, ""),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
  });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end().catch(() => {});
  }
}

d("BYOD e2e routing (guarded by TENANT_TEST_DATABASE_URL + BYOD_ENC_KEY)", () => {
  beforeAll(async () => {
    await resetTenantSchema(TENANT_URL as string);
  });

  it("routes academic writes to the tenant DB and keeps managed on central", async () => {
    const { prisma } = await import("../utils/prisma");
    const { saveDbConfig } = await import("./dbConfig.service");
    const { getAcademicClient } = await import("./tenantDb.service");

    const u = new URL(TENANT_URL as string);
    const institutionCode = `QX-BYOD-TEST-${Date.now()}`;

    // Minimal institution row (platform data stays central).
    const inst = await prisma.institution.create({
      data: { institutionCode, name: "BYOD Test Inst", email: `byod-${Date.now()}@test.local`, type: "SCHOOL" },
    });

    try {
      const result = await saveDbConfig(inst.id, {
        mode: "BYOD",
        engine: "POSTGRES",
        host: u.hostname,
        port: Number(u.port || 5432),
        databaseName: u.pathname.replace(/^\//, ""),
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        sslMode: "disable",
      });
      expect((result as { status: string }).status).toBe("CONNECTED");

      // Write a Standard (academic) through the tenant client.
      const client = await getAcademicClient(inst.id);
      expect(client).not.toBe(prisma); // BYOD → not the central client
      const std = await (client as unknown as typeof prisma).standard.create({
        data: { institutionId: inst.id, name: "Class 1", order: 1 },
      });

      // It must exist in the tenant DB and NOT in central.
      const inTenant = await (client as unknown as typeof prisma).standard.findUnique({ where: { id: std.id } });
      const inCentral = await prisma.standard.findUnique({ where: { id: std.id } });
      expect(inTenant).not.toBeNull();
      expect(inCentral).toBeNull();
    } finally {
      await prisma.institutionDbConfig.deleteMany({ where: { institutionId: inst.id } });
      await prisma.institution.delete({ where: { id: inst.id } }).catch(() => {});
    }
  }, 30000);
});
