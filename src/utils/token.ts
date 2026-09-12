import crypto from "crypto";

export const generateToken = (): string => {
  return crypto.randomBytes(32).toString("hex");
};

export const hashToken = (token: string): string => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

// ── Invite expiry ────────────────────────────────────────────────────────────
//
// Single source of truth for how long an invite/set-password token is valid.
// Previously the duration was a magic-number literal repeated at every
// `expiresAt: new Date(Date.now() + N)` call site AND, separately, hand-typed
// into the matching email's copy ("This link expires in 7 days") — six+
// independent places that had to be kept in sync by hand, with nothing
// enforcing it. Changing the real duration in one spot and forgetting the
// others would make an email quietly promise a window that isn't the one
// actually enforced by auth.service.ts's `invite.expiresAt < new Date()` check.
//
// Fix: controllers compute `expiresAt` from these constants, and pass the same
// constant to the email function, which derives its wording from it via
// `formatExpiryLabel` — so the displayed text can never drift from the real
// value used to create that specific invite.
export const TEACHER_INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SUBADMIN_INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const ADMIN_INVITE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

/** Renders a millisecond duration as the human-readable phrase an email shows. */
export const formatExpiryLabel = (ms: number): string => {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) {
    const h = Math.round(hours);
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
};