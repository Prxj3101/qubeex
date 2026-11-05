import { prisma } from "../utils/prisma";
import { redis } from "../utils/redis";
import { getAcademicClient } from "./tenantDb.service";
import { createNotification } from "./notification.service";
import { pushToUsers } from "./pushNotification.service";
import { readTripState, etaFromState, syncTrip, type BusTimings } from "./tripProgress";
import type { GpsFix } from "./gps.service";

// Bus alerts, worked out on every GPS fix (real tracker or demo bus):
//   parents  - "Bus is ~2 min from your stop"   (once per trip, per child)
//            - "Bus reached school"            (after a pickup trip, once)
//   admins   - "Bus is over speed"             (sustained, at most every 15 min)
//            - "Bus stopped sending its location" during a trip (watchdog, once per trip)
// Parents can switch their alerts off in the app (Student.extraDetailFields["bus-alerts"] = "off").
// Everything here is best-effort: it never throws back into the GPS endpoint.

export const BUS_ALERTS_KEY = "bus-alerts";
const ARRIVING_MIN = 3;            // "almost here" once the ETA is this or less
const OVERSPEED_KMH = 50;
const OVERSPEED_FIXES = 2;         // in a row, so one GPS glitch doesn't alert
const OVERSPEED_EVERY_MS = 15 * 60_000;
const OFFLINE_AFTER_MS = 3 * 60_000;
const EVAL_EVERY_MS = 8_000;       // per bus, at most this often
const CTX_TTL_MS = 60_000;         // bus / riders cache

type Pt = { lat: number; lng: number };
type Ctx = {
  at: number;
  institutionId: string;
  name: string;
  timings: BusTimings;
  stops: (Pt & { id: string; name: string })[];
  school: Pt | null;
  riders: { userId: string; stopId: string | null; shift: string; alertsOff: boolean }[];
};

const ctxCache = new Map<string, Ctx>();
const lastEval = new Map<string, number>();
const lastSeen = new Map<string, { t: number; institutionId: string }>();
const speeding = new Map<string, number>();

// ── once-only guard (Redis, with memory fallback) ───────────────────────────
const memOnce = new Map<string, number>();
async function once(key: string, ttlS: number): Promise<boolean> {
  if (redis) {
    try { return (await redis.set(`busalert:${key}`, "1", "EX", ttlS, "NX")) === "OK"; } catch { /* memory */ }
  }
  const now = Date.now();
  if ((memOnce.get(key) ?? 0) > now) return false;
  memOnce.set(key, now + ttlS * 1000);
  if (memOnce.size > 5000) for (const [k, exp] of memOnce) if (exp < now) memOnce.delete(k);
  return true;
}

async function loadCtx(trackerId: string, institutionId: string): Promise<Ctx | null> {
  const hit = ctxCache.get(trackerId);
  if (hit && Date.now() - hit.at < CTX_TTL_MS) return hit;
  const db = await getAcademicClient(institutionId);
  const bus = await db.transportBus.findFirst({
    where: { institutionId, trackerId },
    select: {
      id: true, name: true,
      morningShift: true, afternoonShift: true, morningPickup: true, morningDrop: true, afternoonPickup: true, afternoonDrop: true,
      route: { select: { stops: { orderBy: { sequence: "asc" }, select: { id: true, name: true, lat: true, lng: true } } } },
    },
  });
  if (!bus) { ctxCache.delete(trackerId); return null; }
  const [riders, inst] = await Promise.all([
    db.studentTransport.findMany({ where: { busId: bus.id }, select: { shift: true, stopId: true, student: { select: { userId: true, extraDetailFields: true } } } }),
    prisma.institution.findUnique({ where: { id: institutionId }, select: { schoolLat: true, schoolLng: true } }),
  ]);
  const ctx: Ctx = {
    at: Date.now(),
    institutionId,
    name: bus.name,
    timings: bus,
    stops: bus.route?.stops ?? [],
    school: inst?.schoolLat != null && inst.schoolLng != null ? { lat: inst.schoolLat, lng: inst.schoolLng } : null,
    riders: riders.map((r) => ({
      userId: r.student.userId,
      stopId: r.stopId,
      shift: r.shift,
      alertsOff: ((r.student.extraDetailFields ?? {}) as Record<string, unknown>)[BUS_ALERTS_KEY] === "off",
    })),
  };
  ctxCache.set(trackerId, ctx);
  return ctx;
}

/** Stop watching these trackers (e.g. demo buses when the demo is stopped: no "went offline" alert). */
export function forgetTrackers(trackerIds: string[]) {
  for (const id of trackerIds) { lastSeen.delete(id); lastEval.delete(id); speeding.delete(id); }
}

/** Forget cached bus info (after riders / stops / alert settings change). */
export const forgetBusAlertCache = () => ctxCache.clear();

// Which shift a trip that left school at `t` belongs to (null = can't tell / combined trip: everyone).
const IST = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
const hhmm = (s: string) => { const m = /^(\d{2}):(\d{2})$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function tripShift(b: BusTimings, t: number): "MORNING" | "AFTERNOON" | null {
  if (b.morningShift && b.afternoonShift && b.morningDrop && b.morningDrop === b.afternoonPickup) {
    // combined midday trip serves both shifts; the first and last trips are one shift each
    const [h, m] = IST.format(new Date(t)).split(":").map(Number);
    const now = h * 60 + m, mid = hhmm(b.morningDrop);
    if (mid != null && Math.abs(now - mid) <= 90) return null;
  }
  const [h, m] = IST.format(new Date(t)).split(":").map(Number);
  const now = h * 60 + m;
  let best: { gap: number; shift: "MORNING" | "AFTERNOON" } | null = null;
  const consider = (at: string, shift: "MORNING" | "AFTERNOON") => {
    const v = hhmm(at);
    if (v == null) return;
    const gap = Math.abs(now - v);
    if (gap <= 90 && (!best || gap < best.gap)) best = { gap, shift };
  };
  if (b.morningShift) { consider(b.morningPickup, "MORNING"); consider(b.morningDrop, "MORNING"); }
  if (b.afternoonShift) { consider(b.afternoonPickup, "AFTERNOON"); consider(b.afternoonDrop, "AFTERNOON"); }
  return (best as { shift: "MORNING" | "AFTERNOON" } | null)?.shift ?? null;
}

/** Call on every GPS fix of a tracker that belongs to `institutionId`. */
export async function onBusFix(trackerId: string, fix: GpsFix, institutionId: string): Promise<void> {
  lastSeen.set(trackerId, { t: Date.now(), institutionId });
  try {
    // ── admin: over speed (checked on every fix) ──
    if (fix.speedKmh > OVERSPEED_KMH) {
      const n = (speeding.get(trackerId) ?? 0) + 1;
      speeding.set(trackerId, n);
      if (n >= OVERSPEED_FIXES && (await once(`speed:${trackerId}`, OVERSPEED_EVERY_MS / 1000))) {
        const ctx = await loadCtx(trackerId, institutionId);
        if (ctx) await adminAlert(institutionId, `⚠️ ${ctx.name} is over speed`, `${ctx.name} is going ${Math.round(fix.speedKmh)} km/h (limit ${OVERSPEED_KMH} km/h).`);
      }
    } else speeding.delete(trackerId);

    // ── the rest at most every few seconds per bus ──
    const now = Date.now();
    if (now - (lastEval.get(trackerId) ?? 0) < EVAL_EVERY_MS) return;
    lastEval.set(trackerId, now);
    const ctx = await loadCtx(trackerId, institutionId);
    if (!ctx || !ctx.stops.length || !ctx.riders.length) return;
    const st = await syncTrip(trackerId, fix, ctx.stops, ctx.school, ctx.timings);
    const listeners = (shift: ReturnType<typeof tripShift>) => ctx.riders.filter((r) => !r.alertsOff && (!shift || r.shift === shift));

    // parents: reached school, after a pickup trip
    if (!st.active && st.atSchool && st.ended?.order === "FORWARD" && now - st.ended.at < 10 * 60_000) {
      if (await once(`school:${trackerId}:${st.ended.at}`, 12 * 3600)) {
        const who = listeners(tripShift(ctx.timings, st.ended.startedAt ?? st.ended.at)).map((r) => r.userId);
        await pushToUsers(who, `🏫 ${ctx.name} reached school`, "The school bus has reached school.", { type: "BUS" });
      }
      return;
    }
    if (!st.active) return;

    // parents: almost at your stop (route-aware ETA, once per trip per child)
    const shift = tripShift(ctx.timings, st.startedAt);
    for (const r of listeners(shift)) {
      if (!r.stopId) continue;
      const eta = etaFromState(st, fix, ctx.stops, r.stopId);
      const coming = eta.atStop || (eta.stopsBefore === 0 && eta.etaMinutes != null && eta.etaMinutes <= ARRIVING_MIN);
      if (!coming) continue;
      if (!(await once(`near:${trackerId}:${st.startedAt}:${r.userId}`, 12 * 3600))) continue;
      const stop = ctx.stops.find((s) => s.id === r.stopId)?.name ?? "your stop";
      await pushToUsers(
        [r.userId],
        eta.atStop ? `🚌 ${ctx.name} is at your stop` : `🚌 ${ctx.name} is almost here`,
        eta.atStop ? `The bus is at ${stop} now.` : `About ${Math.max(1, eta.etaMinutes ?? 1)} min from ${stop}. Please be ready at the stop.`,
        { type: "BUS" },
      );
    }
  } catch (err) {
    console.error("[bus-alerts]", (err as Error).message);
  }
}

async function adminAlert(institutionId: string, title: string, message: string) {
  try {
    await createNotification({ title, message, tag: "TRANSPORT", recipientType: "SYSTEM", adminOnly: true, recipients: [{ institutionId }] });
  } catch (err) {
    console.error("[bus-alerts] admin notification failed:", (err as Error).message);
  }
}

// ── watchdog: a bus on a trip that stopped sending its location ─────────────
let watchdog: ReturnType<typeof setInterval> | null = null;
export function startBusWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(async () => {
    const now = Date.now();
    for (const [trackerId, seen] of lastSeen) {
      if (now - seen.t < OFFLINE_AFTER_MS) continue;
      if (now - seen.t > 6 * 3600_000) { lastSeen.delete(trackerId); continue; } // long gone: forget
      try {
        const st = await readTripState(trackerId);
        if (!st?.active) continue; // parked / no trip: going quiet is normal
        if (!(await once(`offline:${trackerId}:${st.startedAt}`, 12 * 3600))) continue;
        const ctx = await loadCtx(trackerId, seen.institutionId);
        if (!ctx) continue;
        const mins = Math.round((now - seen.t) / 60_000);
        await adminAlert(seen.institutionId, `📡 ${ctx.name} stopped sending its location`, `No GPS update from ${ctx.name} for ${mins} min during a trip. The tracker may be off or out of network.`);
      } catch (err) {
        console.error("[bus-alerts] watchdog:", (err as Error).message);
      }
    }
  }, 60_000);
  watchdog.unref?.();
}
