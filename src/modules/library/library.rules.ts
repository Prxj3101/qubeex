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

export function borrowerTypeForRole(role: string): BorrowerType {
  if (role === "STUDENT") return "STUDENT";
  if (role === "TEACHER") return "TEACHER";
  if (role === "ADMIN" || role === "SUB_ADMIN") return "STAFF";
  throw new Error(`Role ${role} cannot borrow library books`);
}

export function computeDueAt(from: Date, loanDays: number): Date {
  return new Date(from.getTime() + loanDays * DAY_MS);
}

// Late days = difference between UTC calendar dates, so returning later on the due date is free.
export function computeLateFinePaise(dueAt: Date, returnedAt: Date, rule: RuleSet): number {
  const utcDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);
  const lateDays = Math.max(0, utcDay(returnedAt) - utcDay(dueAt) - rule.graceDays);
  const amount = lateDays * rule.finePerDayPaise;
  return rule.fineCapPaise === null ? amount : Math.min(amount, rule.fineCapPaise);
}

export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase();
}
