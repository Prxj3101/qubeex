import { academicRoutingMiddleware } from "./academicRouting.middleware";
import { academicDb } from "../utils/academicContext";
import * as tenantDb from "../services/tenantDb.service";
import type { AuthRequest } from "./auth.middleware";
import type { Response } from "express";

jest.mock("../services/tenantDb.service", () => ({
  getAcademicClient: jest.fn(),
  ByodUnavailableError: class extends Error { code = "INSTITUTION_DB_UNAVAILABLE"; },
}));

const getAcademicClient = tenantDb.getAcademicClient as jest.Mock;

const mockRes = () => {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe("academicRoutingMiddleware", () => {
  afterEach(() => jest.clearAllMocks());

  it("passes through (no context) when there is no institution", async () => {
    const next = jest.fn();
    await academicRoutingMiddleware({ user: {} } as AuthRequest, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getAcademicClient).not.toHaveBeenCalled();
  });

  it("runs next() inside a context where academicDb() returns the resolved client", async () => {
    const sentinel = { marker: "tenant" };
    getAcademicClient.mockResolvedValue(sentinel);
    let seen: unknown;
    const next = jest.fn(() => { seen = academicDb(); });
    await academicRoutingMiddleware({ user: { institutionId: "i1" } } as AuthRequest, mockRes(), next);
    expect(getAcademicClient).toHaveBeenCalledWith("i1");
    expect(next).toHaveBeenCalledTimes(1);
    expect(seen).toBe(sentinel);
  });

  it("returns 503 INSTITUTION_DB_UNAVAILABLE when the tenant DB is unavailable", async () => {
    getAcademicClient.mockRejectedValue(Object.assign(new Error("down"), { code: "INSTITUTION_DB_UNAVAILABLE" }));
    const res = mockRes();
    const next = jest.fn();
    await academicRoutingMiddleware({ user: { institutionId: "i2" } } as AuthRequest, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "INSTITUTION_DB_UNAVAILABLE" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards non-BYOD errors to next(err)", async () => {
    const boom = new Error("boom");
    getAcademicClient.mockRejectedValue(boom);
    const next = jest.fn();
    await academicRoutingMiddleware({ user: { institutionId: "i3" } } as AuthRequest, mockRes(), next);
    expect(next).toHaveBeenCalledWith(boom);
  });
});
