const mockPrisma = {
  librarySettings: { findMany: jest.fn() },
  institution: { findMany: jest.fn() },
  libraryLoan: { findMany: jest.fn(), updateMany: jest.fn() },
  user: { findMany: jest.fn() },
  subAdmin: { findMany: jest.fn() },
};
jest.mock("../utils/prisma", () => ({ prisma: mockPrisma }));
jest.mock("../services/notification.service", () => ({ createNotification: jest.fn() }));
jest.mock("../services/email.service", () => ({ sendLibraryReminderEmail: jest.fn() }));
jest.mock("../services/cronTracker.service", () => ({ recordCronRun: jest.fn() }));

import { runLibraryReminders, selectLoansToRemind } from "./libraryReminder.cron";
import { createNotification } from "../services/notification.service";
import { sendLibraryReminderEmail } from "../services/email.service";

const DAY = 864e5;
const now = new Date("2026-11-10T08:00:00.000Z");
const at = (days: number) => new Date(now.getTime() + days * DAY);
const loan = (over: Record<string, unknown> = {}) => ({
  id: "l1", institutionId: "school-a", borrowerUserId: "u1", dueAt: at(1), lastRemindedAt: null, copy: { book: { title: "Wings of Fire" } }, ...over,
});

describe("selectLoansToRemind", () => {
  test("due within the window is picked, due after it is not", () => {
    const picked = selectLoansToRemind([loan({ id: "a", dueAt: at(2) }), loan({ id: "b", dueAt: at(3) })], now, 2);
    expect(picked.map((l) => l.id)).toEqual(["a"]);
  });
  test("overdue loans are picked and flagged overdue", () => {
    const [l] = selectLoansToRemind([loan({ dueAt: at(-3) })], now, 2);
    expect(l.overdue).toBe(true);
  });
  test("a loan already reminded today is skipped, one reminded yesterday is not", () => {
    const picked = selectLoansToRemind([
      loan({ id: "today", lastRemindedAt: new Date("2026-11-10T01:00:00.000Z") }),
      loan({ id: "yesterday", lastRemindedAt: new Date("2026-11-09T20:00:00.000Z") }),
    ], now, 2);
    expect(picked.map((l) => l.id)).toEqual(["yesterday"]);
  });
  test("dueSoonDays of 0 reminds only on or after the due moment", () => {
    expect(selectLoansToRemind([loan({ dueAt: at(1) })], now, 0)).toHaveLength(0);
    expect(selectLoansToRemind([loan({ dueAt: at(-1) })], now, 0)).toHaveLength(1);
  });
});

describe("runLibraryReminders", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.librarySettings.findMany.mockResolvedValue([{ institutionId: "school-a", dueSoonDays: 2 }]);
    mockPrisma.institution.findMany.mockResolvedValue([{ id: "school-a", name: "Green Valley School" }]);
    mockPrisma.libraryLoan.findMany.mockResolvedValue([loan()]);
    mockPrisma.libraryLoan.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findMany.mockImplementation(async ({ where }: { where: { role?: string } }) =>
      where.role === "ADMIN" ? [{ id: "admin1" }] : [{ id: "u1", name: "Asha", email: "asha@example.com", isActive: true }]);
    mockPrisma.subAdmin.findMany.mockResolvedValue([{ userId: "lib1" }]);
  });

  test("only institutions with saved rules and an ACTIVE status are processed", async () => {
    await runLibraryReminders(now);
    expect(mockPrisma.librarySettings.findMany.mock.calls[0][0].where).toEqual({ rulesConfigured: true });
    expect(mockPrisma.institution.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["school-a"] }, status: "ACTIVE" });
  });

  test("a borrower with a due-soon book gets one notification and one email, and the loan is marked reminded", async () => {
    await runLibraryReminders(now);
    const calls = (createNotification as jest.Mock).mock.calls.map((c) => c[0]);
    const borrower = calls.find((c) => c.recipients[0].userId === "u1");
    expect(borrower).toMatchObject({ tag: "LIBRARY", recipientType: "SYSTEM", recipients: [{ institutionId: "school-a", userId: "u1" }] });
    expect(borrower.message).toContain("Wings of Fire");
    expect(sendLibraryReminderEmail).toHaveBeenCalledTimes(1);
    expect((sendLibraryReminderEmail as jest.Mock).mock.calls[0][0]).toMatchObject({ to: "asha@example.com", institutionName: "Green Valley School" });
    expect(mockPrisma.libraryLoan.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["l1"] }, institutionId: "school-a" }, data: { lastRemindedAt: now } });
  });

  test("a borrower without an email still gets the notification but no email", async () => {
    mockPrisma.user.findMany.mockImplementation(async ({ where }: { where: { role?: string } }) =>
      where.role === "ADMIN" ? [] : [{ id: "u1", name: "Asha", email: null, isActive: true }]);
    await runLibraryReminders(now);
    expect(createNotification).toHaveBeenCalled();
    expect(sendLibraryReminderEmail).not.toHaveBeenCalled();
  });

  test("a deactivated borrower is not messaged but the loan is still marked so the librarian summary does not repeat", async () => {
    mockPrisma.libraryLoan.findMany.mockResolvedValue([loan({ dueAt: at(-2) })]);
    mockPrisma.user.findMany.mockImplementation(async ({ where }: { where: { role?: string } }) =>
      where.role === "ADMIN" ? [{ id: "admin1" }] : [{ id: "u1", name: "Asha", email: "a@x.com", isActive: false }]);
    await runLibraryReminders(now);
    const toBorrower = (createNotification as jest.Mock).mock.calls.filter((c) => c[0].recipients.some((r: { userId: string }) => r.userId === "u1"));
    expect(toBorrower).toHaveLength(0);
    expect(sendLibraryReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.libraryLoan.updateMany).toHaveBeenCalled();
  });

  test("overdue books send one summary to admins and librarians, but due-soon alone does not", async () => {
    await runLibraryReminders(now);
    expect((createNotification as jest.Mock).mock.calls.filter((c) => c[0].title.includes("overdue"))).toHaveLength(0);

    jest.clearAllMocks();
    mockPrisma.libraryLoan.findMany.mockResolvedValue([loan({ dueAt: at(-5) })]);
    mockPrisma.libraryLoan.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findMany.mockImplementation(async ({ where }: { where: { role?: string } }) =>
      where.role === "ADMIN" ? [{ id: "admin1" }] : [{ id: "u1", name: "Asha", email: null, isActive: true }]);
    mockPrisma.subAdmin.findMany.mockResolvedValue([{ userId: "lib1" }]);
    await runLibraryReminders(now);
    const summary = (createNotification as jest.Mock).mock.calls.map((c) => c[0]).filter((c) => c.title.includes("overdue"));
    expect(summary).toHaveLength(1);
    expect(summary[0].recipients.map((r: { userId: string }) => r.userId).sort()).toEqual(["admin1", "lib1"]);
    expect(mockPrisma.subAdmin.findMany.mock.calls[0][0].where).toEqual({ institutionId: "school-a", permissions: { has: "LIBRARY" } });
  });

  test("nothing to remind means no notifications and no updates", async () => {
    mockPrisma.libraryLoan.findMany.mockResolvedValue([loan({ dueAt: at(10) })]);
    await runLibraryReminders(now);
    expect(createNotification).not.toHaveBeenCalled();
    expect(mockPrisma.libraryLoan.updateMany).not.toHaveBeenCalled();
  });

  test("one institution failing does not stop the next", async () => {
    mockPrisma.librarySettings.findMany.mockResolvedValue([{ institutionId: "school-a", dueSoonDays: 2 }, { institutionId: "school-b", dueSoonDays: 2 }]);
    mockPrisma.institution.findMany.mockResolvedValue([{ id: "school-a", name: "A" }, { id: "school-b", name: "B" }]);
    mockPrisma.libraryLoan.findMany.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce([loan({ institutionId: "school-b" })]);
    await runLibraryReminders(now);
    expect(createNotification).toHaveBeenCalled();
  });
});
