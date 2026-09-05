import { prisma } from "../utils/prisma";

// Coordinated color families offered in the self-service theme picker. Each
// name maps to a full light+dark palette defined client-side (web:
// globals.css presets, app: ThemeContext) — this list is the single source
// of truth for which values are valid, shared by the write-path validator
// below and the frontends' picker UI.
export const THEME_COLORS = ["purple", "blue", "teal", "amber", "rose", "indigo", "slate"] as const;
export type ThemeColor = (typeof THEME_COLORS)[number];
export const DEFAULT_THEME_COLOR: ThemeColor = "purple";

export const isValidThemeColor = (value: string): value is ThemeColor =>
  (THEME_COLORS as readonly string[]).includes(value);

// Theme customization is available to PRO (active) and to anyone currently on
// TRIAL (trials get the fuller feature set), same shape as
// isWhiteLabelEligible in whiteLabel.service.ts. Re-checked on every write —
// never trust a cached/stale client-side flag — so a lapsed Pro subscription
// silently loses the ability to change the theme (existing themeColor value
// is left as-is, just no longer editable, until it's reset by a future
// admin action if ever needed).
export const isThemeCustomizationEligible = async (institutionId: string): Promise<boolean> => {
  const subscription = await prisma.subscription.findUnique({
    where: { institutionId },
    include: { plan: { select: { name: true } } },
  });
  if (!subscription) return false;
  if (subscription.status === "TRIAL") return true;
  return subscription.status === "ACTIVE" && subscription.plan.name === "PRO";
};
