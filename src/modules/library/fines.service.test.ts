import { createFinesForReturn } from "./fines.service";
import type { RuleSet } from "./library.rules";

const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "f1", ...data }));
const tx = { libraryFine: { create } } as never;
beforeEach(() => jest.clearAllMocks());

const rule: RuleSet = { maxBooks: 2, loanDays: 14, maxRenewals: 1, finePerDayPaise: 200, graceDays: 0, fineCapPaise: null };
const settings = (finesMode: string, extra: Record<string, number> = {}) =>
  ({ finesMode, lostChargePaise: 0, damagedChargePaise: 0, ...extra }) as never;
const loan = { id: "loan1", borrowerUserId: "user1", dueAt: new Date("2026-11-10T10:00:00.000Z") };
const base = { institutionId: "school-a", loan, returnedAt: new Date("2026-11-13T10:00:00.000Z"), borrowerType: "STUDENT" as const, rule };

test("mode OFF creates nothing even when late", async () => {
  expect(await createFinesForReturn(tx, { ...base, condition: "OK", settings: settings("OFF"), rule })).toEqual([]);
  expect(create).not.toHaveBeenCalled();
});

test("librarian mode: 3 days late makes one LATE fine collected by the librarian", async () => {
  const fines = await createFinesForReturn(tx, { ...base, condition: "OK", settings: settings("LIBRARIAN") });
  expect(fines).toHaveLength(1);
  expect(create.mock.calls[0][0].data).toMatchObject({
    institutionId: "school-a", loanId: "loan1", borrowerUserId: "user1", kind: "LATE", amountPaise: 600, collectedVia: "LIBRARIAN", status: "PENDING",
  });
});

test("fees mode sends a student's fine to fees", async () => {
  await createFinesForReturn(tx, { ...base, condition: "OK", settings: settings("FEES") });
  expect(create.mock.calls[0][0].data.collectedVia).toBe("FEES");
});

test("fees mode falls back to the librarian for a teacher", async () => {
  await createFinesForReturn(tx, { ...base, borrowerType: "TEACHER", condition: "OK", settings: settings("FEES") });
  expect(create.mock.calls[0][0].data.collectedVia).toBe("LIBRARIAN");
});

test("returned on time creates nothing", async () => {
  expect(await createFinesForReturn(tx, { ...base, returnedAt: loan.dueAt, condition: "OK", settings: settings("LIBRARIAN") })).toEqual([]);
});

test("a lost book with no lost charge set creates no LOST fine", async () => {
  const fines = await createFinesForReturn(tx, { ...base, returnedAt: loan.dueAt, condition: "LOST", settings: settings("LIBRARIAN") });
  expect(fines).toEqual([]);
});

test("a lost book creates a LOST fine at the configured charge, plus any late fine", async () => {
  await createFinesForReturn(tx, { ...base, condition: "LOST", settings: settings("LIBRARIAN", { lostChargePaise: 40000 }) });
  expect(create.mock.calls.map((c) => [c[0].data.kind, c[0].data.amountPaise])).toEqual([["LATE", 600], ["LOST", 40000]]);
});

test("a damaged book creates a DAMAGED fine at the configured charge", async () => {
  await createFinesForReturn(tx, { ...base, returnedAt: loan.dueAt, condition: "DAMAGED", settings: settings("LIBRARIAN", { damagedChargePaise: 7500 }) });
  expect(create.mock.calls.map((c) => [c[0].data.kind, c[0].data.amountPaise])).toEqual([["DAMAGED", 7500]]);
});
