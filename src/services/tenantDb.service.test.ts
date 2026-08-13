import { prisma } from "../utils/prisma";
import { getAcademicClient, ByodUnavailableError } from "./tenantDb.service";

jest.mock("../utils/prisma", () => ({
  prisma: { institutionDbConfig: { findUnique: jest.fn() } },
}));

const findUnique = prisma.institutionDbConfig.findUnique as jest.Mock;

describe("getAcademicClient", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns the central prisma for an unconfigured institution (managed invariant)", async () => {
    findUnique.mockResolvedValue(null);
    const client = await getAcademicClient("inst-1");
    expect(client).toBe(prisma);
  });

  it("returns the central prisma for an explicitly MANAGED institution", async () => {
    findUnique.mockResolvedValue({ mode: "MANAGED" });
    const client = await getAcademicClient("inst-2");
    expect(client).toBe(prisma);
  });

  it("throws ByodUnavailableError when a BYOD Postgres config is incomplete", async () => {
    // Missing host/port/credentials — cannot build a client regardless of status.
    findUnique.mockResolvedValue({ institutionId: "inst-3", mode: "BYOD", engine: "POSTGRES", status: "CONNECTED" });
    await expect(getAcademicClient("inst-3")).rejects.toBeInstanceOf(ByodUnavailableError);
  });

  it("throws ByodUnavailableError for an unsupported engine even if connected", async () => {
    findUnique.mockResolvedValue({ institutionId: "inst-4", mode: "BYOD", engine: "MYSQL", status: "CONNECTED" });
    const err = await getAcademicClient("inst-4").catch((e) => e);
    expect(err).toBeInstanceOf(ByodUnavailableError);
    expect(err.code).toBe("INSTITUTION_DB_UNAVAILABLE");
  });
});
