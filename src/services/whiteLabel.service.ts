import { prisma } from "../utils/prisma";
import { logAudit } from "./audit.service";
import { getCache, setCache, delCache } from "../utils/cache";
import { uploadImageToR2 } from "./storage.service";
import { BadRequestError, NotFoundError } from "../utils/errors";

const BRANDING_CACHE_TTL_SECONDS = 300;
const brandingCacheKey = (institutionId: string) => `branding:${institutionId}`;

export const QUBEEX_DEFAULT_BRANDING = {
  enabled: false,
  brandName: "QubeEx",
  logoUrl: "/QubeEx_darkmode_DA7756.png",
  faviconUrl: "/favicon.ico",
} as const;

export type EffectiveBranding = {
  enabled: boolean;
  brandName: string;
  logoUrl: string;
  faviconUrl: string;
};

// White-labeling is a Pro-plan feature derived from the institution's existing
// subscription state — not a separate entitlement system. Re-checked on every
// read, not just when toggled on, so a lapsed/paused/expired Pro subscription
// silently loses white-label access without needing an explicit disable.
export const isWhiteLabelEligible = async (institutionId: string): Promise<boolean> => {
  const subscription = await prisma.subscription.findUnique({
    where: { institutionId },
    include: { plan: { select: { name: true } } },
  });
  return !!subscription && subscription.status === "ACTIVE" && subscription.plan.name === "PRO";
};

/** Superadmin-facing: raw stored config plus current eligibility, regardless of enabled state. */
export const getWhiteLabelConfig = async (institutionId: string) => {
  const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
  if (!institution) throw new NotFoundError("Institution not found");

  const [config, eligible] = await Promise.all([
    prisma.whiteLabelConfig.findUnique({ where: { institutionId } }),
    isWhiteLabelEligible(institutionId),
  ]);

  return {
    eligible,
    enabled: config?.enabled ?? false,
    brandName: config?.brandName ?? null,
    logoUrl: config?.logoUrl ?? null,
    faviconUrl: config?.faviconUrl ?? null,
    updatedAt: config?.updatedAt ?? null,
  };
};

/** What the frontend actually renders — QubeEx defaults unless genuinely eligible AND enabled. Cached. */
export const getEffectiveBranding = async (institutionId: string): Promise<EffectiveBranding> => {
  const cached = await getCache<EffectiveBranding>(brandingCacheKey(institutionId));
  if (cached) return cached;

  const [config, eligible] = await Promise.all([
    prisma.whiteLabelConfig.findUnique({ where: { institutionId } }),
    isWhiteLabelEligible(institutionId),
  ]);

  const effective: EffectiveBranding = (eligible && config?.enabled)
    ? {
        enabled: true,
        brandName: config.brandName || QUBEEX_DEFAULT_BRANDING.brandName,
        logoUrl: config.logoUrl || QUBEEX_DEFAULT_BRANDING.logoUrl,
        faviconUrl: config.faviconUrl || QUBEEX_DEFAULT_BRANDING.faviconUrl,
      }
    : { ...QUBEEX_DEFAULT_BRANDING };

  await setCache(brandingCacheKey(institutionId), effective, BRANDING_CACHE_TTL_SECONDS);
  return effective;
};

const invalidateBrandingCache = (institutionId: string) => delCache(brandingCacheKey(institutionId));

interface UpdateWhiteLabelInput {
  enabled?: boolean;
  brandName?: string | null;
  logoUrl?: string | null;
  faviconUrl?: string | null;
}

export const updateWhiteLabelConfig = async (
  institutionId: string,
  input: UpdateWhiteLabelInput,
  actorId?: string
) => {
  const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
  if (!institution) throw new NotFoundError("Institution not found");

  const existing = await prisma.whiteLabelConfig.findUnique({ where: { institutionId } });

  // Never trust the frontend: re-validate eligibility server-side before allowing enable.
  if (input.enabled === true) {
    const eligible = await isWhiteLabelEligible(institutionId);
    if (!eligible) {
      throw new BadRequestError(
        "White-labeling requires an active Pro plan. Activate/renew Pro before enabling white-labeling for this institution."
      );
    }
  }

  const previous = {
    enabled: existing?.enabled ?? false,
    brandName: existing?.brandName ?? null,
    logoUrl: existing?.logoUrl ?? null,
    faviconUrl: existing?.faviconUrl ?? null,
  };

  const updated = await prisma.whiteLabelConfig.upsert({
    where: { institutionId },
    create: {
      institutionId,
      enabled: input.enabled ?? false,
      brandName: input.brandName ?? null,
      logoUrl: input.logoUrl ?? null,
      faviconUrl: input.faviconUrl ?? null,
    },
    update: {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.brandName !== undefined ? { brandName: input.brandName } : {}),
      ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      ...(input.faviconUrl !== undefined ? { faviconUrl: input.faviconUrl } : {}),
    },
  });

  await invalidateBrandingCache(institutionId);

  const next = { enabled: updated.enabled, brandName: updated.brandName, logoUrl: updated.logoUrl, faviconUrl: updated.faviconUrl };

  // Distinct audit actions for the enable/disable transition vs. a content edit.
  let action = "WHITE_LABEL_BRANDING_UPDATED";
  if (input.enabled === true && !previous.enabled) action = "WHITE_LABEL_ENABLED";
  else if (input.enabled === false && previous.enabled) action = "WHITE_LABEL_DISABLED";

  logAudit(action, {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: `${institution.name}: white-label ${action === "WHITE_LABEL_ENABLED" ? "enabled" : action === "WHITE_LABEL_DISABLED" ? "disabled" : "branding updated"}`,
    metadata: { previous, next },
  });

  return updated;
};

export const uploadWhiteLabelLogo = async (institutionId: string, file: Buffer, contentType: string, actorId?: string) => {
  const uploaded = await uploadImageToR2(file, {
    contentType,
    folder: `institutions/${institutionId}/white-label`,
    ownerId: institutionId,
  });
  logAudit("WHITE_LABEL_LOGO_UPDATED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: "White-label logo uploaded",
    metadata: { path: uploaded.path, publicUrl: uploaded.publicUrl },
  });
  return { logoUrl: uploaded.publicUrl };
};

export const uploadWhiteLabelFavicon = async (institutionId: string, file: Buffer, contentType: string, actorId?: string) => {
  const uploaded = await uploadImageToR2(file, {
    contentType,
    folder: `institutions/${institutionId}/white-label`,
    ownerId: institutionId,
  });
  logAudit("WHITE_LABEL_LOGO_UPDATED", {
    userId: actorId,
    actorRole: "SUPER_ADMIN",
    institutionId,
    category: "SUPERADMIN_ACTION",
    severity: "INFO",
    details: "White-label favicon uploaded",
    metadata: { path: uploaded.path, publicUrl: uploaded.publicUrl, kind: "favicon" },
  });
  return { faviconUrl: uploaded.publicUrl };
};
