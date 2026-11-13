export type BorrowerType = "STUDENT" | "TEACHER" | "STAFF";

export type RuleSet = {
  maxBooks: number;
  loanDays: number;
  maxRenewals: number;
  finePerDayPaise: number;
  graceDays: number;
  fineCapPaise: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // QubeEx institutions run on India time

export function borrowerTypeForRole(role: string): BorrowerType {
  if (role === "STUDENT") return "STUDENT";
  if (role === "TEACHER") return "TEACHER";
  if (role === "ADMIN" || role === "SUB_ADMIN") return "STAFF";
  throw new Error(`Role ${role} cannot borrow library books`);
}

export function computeDueAt(from: Date, loanDays: number): Date {
  return new Date(from.getTime() + loanDays * DAY_MS);
}

// Late days = difference between India calendar dates, so returning later on the due date is free.
export function computeLateFinePaise(dueAt: Date, returnedAt: Date, rule: RuleSet): number {
  const lateDays = Math.max(0, istDayOf(returnedAt) - istDayOf(dueAt) - rule.graceDays);
  const amount = lateDays * rule.finePerDayPaise;
  return rule.fineCapPaise === null ? amount : Math.min(amount, rule.fineCapPaise);
}

const istDayOf = (d: Date) => Math.floor((d.getTime() + IST_OFFSET_MS) / DAY_MS);

// Overdue from the day after the due date, in India time.
export function isOverdue(dueAt: Date, now: Date): boolean {
  return istDayOf(now) > istDayOf(dueAt);
}

export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase();
}
