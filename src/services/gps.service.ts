import { prisma } from "../utils/prisma";
import { redis } from "../utils/redis";

// Live bus positions. Traccar forwards every GPS fix to POST /api/internal/gps;
// we keep only the latest fix per tracker (Redis, with an in-memory fallback)
// because the admin map and the parent app only ever need "where is it now".

export type GpsFix = {
  lat: number;
  lng: number;
  speedKmh: number;
  course: number;   // heading in degrees, 0 = north
  fixTime: string;  // when the tracker took the reading (ISO)
  receivedAt: string;
};

const KEY = (trackerId: string) => `gps:last:${trackerId}`;
const TTL_SECONDS = 24 * 60 * 60;
/** A bus counts as "online" if its last fix is newer than this. */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

const memory = new Map<string, GpsFix>();

export async function saveFix(trackerId: string, fix: GpsFix): Promise<void> {
  memory.set(trackerId, fix);
  if (!redis) return;
  try {
    await redis.set(KEY(trackerId), JSON.stringify(fix), "EX", TTL_SECONDS);
  } catch {
    // Redis down: the in-memory copy still serves this instance
  }
}

export async function getFixes(trackerIds: string[]): Promise<Map<string, GpsFix>> {
  const out = new Map<string, GpsFix>();
  const ids = [...new Set(trackerIds.filter(Boolean))];
  if (!ids.length) return out;
  if (redis) {
    try {
      const values = await redis.mget(...ids.map(KEY));
      values.forEach((v, i) => {
        if (v) out.set(ids[i], JSON.parse(v) as GpsFix);
      });
      return out;
    } catch {
      // fall through to memory
    }
  }
  for (const id of ids) {
    const fix = memory.get(id);
    if (fix) out.set(id, fix);
  }
  return out;
}

export const isOnline = (fix: GpsFix | null | undefined, now = Date.now()) =>
  !!fix && now - new Date(fix.receivedAt).getTime() < ONLINE_WINDOW_MS;

// ── Which school owns a tracker (central registry, cached for a minute) ──────
let trackerOwners: Map<string, string> | null = null;
let trackerOwnersLoadedAt = 0;

export async function trackerInstitution(trackerId: string): Promise<string | null> {
  if (!trackerOwners || Date.now() - trackerOwnersLoadedAt > 60_000) {
    const rows = await prisma.gpsTracker.findMany({ select: { trackerId: true, institutionId: true } });
    trackerOwners = new Map(rows.map((r) => [r.trackerId, r.institutionId]));
    trackerOwnersLoadedAt = Date.now();
  }
  return trackerOwners.get(trackerId) ?? null;
}

/** Call after adding/removing a tracker so the next position is not ignored. */
export const forgetTrackerCache = () => {
  trackerOwners = null;
};

// ── Distance / rough arrival time ────────────────────────────────────────────
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Rough minutes for the bus to reach a stop: straight-line distance stretched
 * by 1.35 for real roads, at the bus's speed (never assumed below 18 km/h, so a
 * bus waiting at a signal doesn't show "2 hours"). Free: no maps API involved.
 */
export function etaMinutes(fix: GpsFix, stop: { lat: number; lng: number }): number {
  const km = distanceKm(fix, stop) * 1.35;
  const speed = Math.max(fix.speedKmh, 18);
  return Math.max(1, Math.round((km / speed) * 60));
}
