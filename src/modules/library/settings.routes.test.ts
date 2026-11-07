import express from "express";
import request from "supertest";
import { errorHandler } from "../../middlewares/errorHandler.middleware";

jest.mock("../../middlewares/auth.middleware", () => ({ authMiddleware: () => (req: any, _res: any, next: any) => {
  req.user = { userId: "u1", institutionId: "school-a", role: req.headers["x-role"] || "ADMIN" }; next();
} }));
jest.mock("../../middlewares/institutionAccess.middleware", () => ({ institutionAccessMiddleware: (_r: any, _s: any, next: any) => next() }));
jest.mock("../../middlewares/academicRouting.middleware", () => ({ academicRoutingMiddleware: (_r: any, _s: any, next: any) => next() }));
jest.mock("../../middlewares/requirePermission.middleware", () => ({ requirePermission: () => (req: any, res: any, next: any) => req.user.role === "SUB_ADMIN" ? res.sendStatus(403) : next() }));
jest.mock("../../services/audit.service", () => ({ logAudit: jest.fn() }));

const mockSettings = { findUnique: jest.fn(), upsert: jest.fn() };
const mockRule = { findMany: jest.fn(), upsert: jest.fn() };
const tx = { librarySettings: mockSettings, libraryRule: mockRule };
jest.mock("../../utils/academicContext", () => ({ academicDb: () => ({
  librarySettings: mockSettings, libraryRule: mockRule,
  $transaction: (fn: (t: unknown) => unknown) => fn(tx),
}) }));

import { authMiddleware } from "../../middlewares/auth.middleware";
import { requirePermission } from "../../middlewares/requirePermission.middleware";
import { settingsRouter, loadActiveRules } from "./settings.routes";
import { logAudit } from "../../services/audit.service";

const app = express();
app.use(express.json()); app.use("/settings", authMiddleware(["ADMIN", "SUB_ADMIN"]), requirePermission("LIBRARY"), settingsRouter); app.use(errorHandler);
beforeEach(() => jest.clearAllMocks());

const rule = { maxBooks: 2, loanDays: 14, maxRenewals: 1, finePerDayPaise: 200, graceDays: 0, fineCapPaise: null };
const valid = {
  finesMode: "LIBRARIAN", dueSoonDays: 2, lostChargePaise: 50000, damagedChargePaise: 10000,
  rules: { STUDENT: rule, TEACHER: { ...rule, maxBooks: 5, loanDays: 30 }, STAFF: rule },
};

test("GET is scoped to the school and reports unconfigured when nothing is saved", async () => {
  mockSettings.findUnique.mockResolvedValue(null); mockRule.findMany.mockResolvedValue([]);
  const res = await request(app).get("/settings");
  expect(res.status).toBe(200);
  expect(res.body.data.rulesConfigured).toBe(false);
  expect(res.body.data.rules).toEqual({ STUDENT: null, TEACHER: null, STAFF: null });
  expect(mockSettings.findUnique.mock.calls[0][0].where).toEqual({ institutionId: "school-a" });
  expect(mockRule.findMany.mock.calls[0][0].where).toEqual({ institutionId: "school-a" });
});

test("PUT rejects an injected institutionId, bad mode, negatives and a missing borrower type", async () => {
  const bad = [
    { ...valid, institutionId: "school-b" },
    { ...valid, finesMode: "X" },
    { ...valid, rules: { ...valid.rules, STUDENT: { ...rule, maxBooks: 0 } } },
    { ...valid, rules: { ...valid.rules, STUDENT: { ...rule, loanDays: 0 } } },
    { ...valid, rules: { ...valid.rules, STUDENT: { ...rule, finePerDayPaise: -1 } } },
    { ...valid, rules: { STUDENT: rule, TEACHER: rule } },
  ];
  for (const body of bad) expect((await request(app).put("/settings").send(body)).status).toBe(400);
  expect(mockSettings.upsert).not.toHaveBeenCalled();
});

test("PUT saves settings and all three rules in one transaction, marks configured and audits", async () => {
  mockSettings.upsert.mockResolvedValue({}); mockRule.upsert.mockResolvedValue({});
  mockSettings.findUnique.mockResolvedValue(null); mockRule.findMany.mockResolvedValue([]);
  const res = await request(app).put("/settings").send(valid);
  expect(res.status).toBe(200);
  expect(mockSettings.upsert.mock.calls[0][0].where).toEqual({ institutionId: "school-a" });
  expect(mockSettings.upsert.mock.calls[0][0].update.rulesConfigured).toBe(true);
  expect(mockRule.upsert).toHaveBeenCalledTimes(3);
  expect(mockRule.upsert.mock.calls[0][0].where).toEqual({ institutionId_borrowerType: { institutionId: "school-a", borrowerType: "STUDENT" } });
  expect(logAudit).toHaveBeenCalledWith("LIBRARY_SETTINGS_UPDATED", expect.objectContaining({ institutionId: "school-a" }));
});

test("a sub-admin without the permission is refused", async () => {
  expect((await request(app).get("/settings").set("x-role", "SUB_ADMIN")).status).toBe(403);
});

describe("loadActiveRules", () => {
  test("throws a conflict when rules are not set up", async () => {
    mockSettings.findUnique.mockResolvedValue({ rulesConfigured: false });
    await expect(loadActiveRules("school-a")).rejects.toThrow("Library rules are not set up yet");
  });
  test("returns settings and a rule per borrower type when configured", async () => {
    mockSettings.findUnique.mockResolvedValue({ rulesConfigured: true, finesMode: "OFF" });
    mockRule.findMany.mockResolvedValue(["STUDENT", "TEACHER", "STAFF"].map((borrowerType) => ({ borrowerType, ...rule })));
    const out = await loadActiveRules("school-a");
    expect(out.rules.TEACHER.loanDays).toBe(14);
    expect(mockRule.findMany.mock.calls[0][0].where).toEqual({ institutionId: "school-a" });
  });
});
