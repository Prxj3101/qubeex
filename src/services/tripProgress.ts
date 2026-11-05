import { redis } from "../utils/redis";
import { distanceKm, type GpsFix } from "./gps.service";
import { isCombinedMidday } from "./transportSchedule";

// Route-aware arrival time.
//
// A plain "distance from the bus to my stop" is wrong for a real school bus:
// on the pickup trip it first drives out to stop 1 (the farthest), and on the
// way it may pass close to stops it will only pick up later. So we follow the
// trip instead:
//   * every GPS fix is kept in a short trail (last hour) per tracker;
//   * a trip starts when the bus leaves school and ends when it's parked back
//     at school;
//   * stops are ticked off IN ORDER: the next stop counts as reached when the
//     bus comes within ~80 m of it; a later stop only counts if the bus
//     actually stops there (slow + close), so just driving past one on the way
//     out doesn't skip anything;
//   * pickup trips go stop 1 -> last, drop trips go last -> stop 1 (the
//     combined midday trip keeps the pickup order). Which one it is comes from
//     the bus timings; if the time doesn't match a trip, from the first stop
//     the bus stops at.
// ETA = bus -> next stop -> ... -> my stop, at 20 km/h on roads (x1.35) plus a
// minute at every stop on the way, same as the planned timings.

const ROAD_FACTOR = 1.35;
const AVG_SPEED_KMH = 20;
const DWELL_MIN = 1;
const REACH_KM = 0.08;      // close enough to count as "at" a stop
const PASS_KM = 0.03;      // driving right over a stop without stopping
const SCHOOL_KM = 0.2;      // inside the school area
const SLOW_KMH = 5;         // stopped / crawling
const AT_STOP_KM = 0.15;    // parents see "at your stop" within this
const TRAIL_MAX = 1200;     // ~1 hour of fixes every 3 s

type Pt = { lat: number; lng: number };
type Order = "FORWARD" | "REVERSE";
type TrailFix = { lat: number; lng: number; s: number; t: number }; // s = km/h, t = ms
// order: from the bus timings at first (a guess); `confirmed` once the bus actually
// stops at the first stop of that order (stop 1 for pickup, last stop for drop).
// ended: how the last trip finished (a pickup trip parked at school = "reached school")
// reached: stops reached on this trip, as route positions (0 = stop 1) + time, for the trip history.
// vmax: top speed on this trip. ended: the last finished trip (kept for "reached school" and history).
export type Reached = { s: number; t: number };
export type EndedTrip = { order: Order | null; at: number; startedAt?: number; reached?: Reached[]; vmax?: number };
export type TripState = {
  atSchool: boolean; active: boolean; order: Order | null; confirmed?: boolean; next: number; lastT: number; startedAt: number;
  reached?: Reached[]; vmax?: number; ended?: EndedTrip;
};

export type BusTimings = {
  morningShift: boolean; afternoonShift: boolean;
  morningPickup: string; morningDrop: string; afternoonPickup: string; afternoonDrop: string;
};

// ── trail (written on every GPS fix) ─────────────────────────────────────────
const TRAIL_KEY = (id: string) => `gps:trail:${id}`;
const STATE_KEY = (id: string) => `gps:trip:${id}`;
const memTrail = new Map<string, TrailFix[]>();
const memState = new Map<string, TripState>();

export async function pushTrail(trackerId: string, fix: GpsFix): Promise<void> {
  const item: TrailFix = { lat: fix.lat, lng: fix.lng, s: fix.speedKmh, t: Date.parse(fix.fixTime) || Date.now() };
  const list = memTrail.get(trackerId) ?? [];
  list.push(item);
  if (list.length > TRAIL_MAX) list.splice(0, list.length - TRAIL_MAX);
  memTrail.set(trackerId, list);
  if (!redis) return;
  try {
    await redis.multi()
      .rpush(TRAIL_KEY(trackerId), JSON.stringify(item))
      .ltrim(TRAIL_KEY(trackerId), -TRAIL_MAX, -1)
      .expire(TRAIL_KEY(trackerId), 24 * 3600)
      .exec();
  } catch { /* memory copy still works on this instance */ }
}

async function readTrail(trackerId: string, after: number): Promise<TrailFix[]> {
  let list: TrailFix[] | null = null;
  if (redis) {
    try { list = (await redis.lrange(TRAIL_KEY(trackerId), 0, -1)).map((v) => JSON.parse(v) as TrailFix); } catch { list = null; }
  }
  return (list ?? memTrail.get(trackerId) ?? []).filter((f) => f.t > after).sort((a, b) => a.t - b.t);
}

async function readState(trackerId: string): Promise<TripState | null> {
  if (redis) {
    try { const v = await redis.get(STATE_KEY(trackerId)); if (v) return JSON.parse(v) as TripState; } catch { /* memory */ }
  }
  return memState.get(trackerId) ?? null;
}

/** Current trip state of a tracker (no update), e.g. for the offline watchdog. */
export const readTripState = (trackerId: string) => readState(trackerId);

async function writeState(trackerId: string, st: TripState): Promise<void> {
  memState.set(trackerId, st);
  if (!redis) return;
  try { await redis.set(STATE_KEY(trackerId), JSON.stringify(st), "EX", 24 * 3600); } catch { /* memory */ }
}

// ── which trip is this (from the bus timings) ────────────────────────────────
const IST = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
const istMinutes = (ms: number) => { const [h, m] = IST.format(new Date(ms)).split(":").map(Number); return h * 60 + m; };
const hhmm = (s: string) => { const m = /^(\d{2}):(\d{2})$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

function orderFromTimings(bus: BusTimings, leftAt: number): Order | null {
  const combined = isCombinedMidday(bus);
  const trips: { at: number | null; order: Order }[] = [];
  if (bus.morningShift) trips.push({ at: hhmm(bus.morningPickup), order: "FORWARD" }, { at: hhmm(bus.morningDrop), order: combined ? "FORWARD" : "REVERSE" });
  if (bus.afternoonShift) { if (!combined) trips.push({ at: hhmm(bus.afternoonPickup), order: "FORWARD" }); trips.push({ at: hhmm(bus.afternoonDrop), order: "REVERSE" }); }
  const now = istMinutes(leftAt);
  let best: { gap: number; order: Order } | null = null;
  for (const t of trips) {
    if (t.at == null) continue;
    const gap = Math.abs(now - t.at);
    if (gap <= 60 && (!best || gap < best.gap)) best = { gap, order: t.order };
  }
  return best?.order ?? null;
}

// ── follow the trail ─────────────────────────────────────────────────────────
// states saved before `confirmed` existed: anything already ticked off counts as confirmed
const confirmedOf = (st: TripState) => st.confirmed ?? st.next > 0;

function advance(st: TripState, fixes: TrailFix[], stops: Pt[], school: Pt | null, bus: BusTimings): TripState {
  const n = stops.length;
  const ordered = (o: Order) => (o === "FORWARD" ? stops : [...stops].reverse());
  // remember "reached position k of the trip" as a route position (stop 1 = 0)
  const mark = (k: number, t: number, o: Order | null) => {
    const s = o === "REVERSE" ? n - 1 - k : k;
    st.reached = [...(st.reached ?? []).filter((r) => r.s !== s), { s, t }];
  };
  for (const f of fixes) {
    if (st.active) st.vmax = Math.max(st.vmax ?? 0, f.s);
    const toSchool = school ? distanceKm(f, school) : Infinity;
    const inSchool = toSchool < SCHOOL_KM;
    // Parked AT school, not at a stop that happens to be near the school (e.g. a
    // stop 150 m from the gate): the school must be the closest place.
    const parkedAtSchool = inSchool && f.s < SLOW_KMH && stops.every((p) => distanceKm(f, p) > toSchool);
    if (st.atSchool) {
      if (!inSchool) st = { atSchool: false, active: true, order: orderFromTimings(bus, f.t), confirmed: false, next: 0, lastT: f.t, startedAt: f.t, reached: [], vmax: f.s, ended: st.ended }; // left school: new trip
    } else if (parkedAtSchool) {
      // parked back at school: trip over (remember which way it went, for "reached school")
      const ended = st.active && confirmedOf(st) ? { order: st.order, at: f.t, startedAt: st.startedAt, reached: st.reached ?? [], vmax: st.vmax ?? 0 } : st.ended;
      st = { ...st, atSchool: true, active: false, order: null, confirmed: false, next: 0, reached: [], vmax: 0, ended };
    } else if (st.active && !confirmedOf(st)) {
      // Which way is it going? The first stop it actually stops at tells us:
      // stop 1 -> pickup order, last stop -> drop order. Until then nothing is
      // ticked off, so driving past other stops on the way out changes nothing
      // (and a wrong guess from the timings gets corrected here).
      if (f.s < SLOW_KMH) {
        if (distanceKm(f, stops[0]) < REACH_KM) { st = { ...st, order: "FORWARD", confirmed: true, next: 1 }; mark(0, f.t, "FORWARD"); }
        else if (n > 1 && distanceKm(f, stops[n - 1]) < REACH_KM) { st = { ...st, order: "REVERSE", confirmed: true, next: 1 }; mark(0, f.t, "REVERSE"); }
      }
    } else if (st.active && st.order) {
      const list = ordered(st.order);
      // the next stop counts once the bus is really there: stopped at it, or driving
      // right over it (no one waiting) - not already when it's 80 m before it
      const dNext = st.next < n ? distanceKm(f, list[st.next]) : Infinity;
      if (dNext < PASS_KM || (dNext < REACH_KM && f.s < SLOW_KMH)) { mark(st.next, f.t, st.order); st.next += 1; }
      else if (f.s < SLOW_KMH) {
        // stopped at a later stop (an earlier one was skipped, e.g. nobody there)
        for (let k = st.next + 1; k < n; k++) if (distanceKm(f, list[k]) < REACH_KM) { mark(k, f.t, st.order); st.next = k + 1; break; }
      }
    }
    st.lastT = f.t;
  }
  return st;
}

/**
 * The stop the bus is at right now: the stop it has just reached (from arriving until
 * it drives ~120 m away, whatever its speed, so a short halt isn't missed between
 * polls), or any stop it's standing still at.
 */
function standingAtOf(st: TripState, fix: GpsFix, stops: (Pt & { name: string })[]): string | null {
  if (!st.active) return null;
  const near = REACH_KM * 1.5;
  if (st.order && confirmedOf(st) && st.next > 0) {
    const list = st.order === "REVERSE" ? [...stops].reverse() : stops;
    const last = list[st.next - 1];
    if (last && distanceKm(fix, last) < near) return last.name;
  }
  return fix.speedKmh < SLOW_KMH ? stops.find((s) => distanceKm(fix, s) < near)?.name ?? null : null;
}

/** Bring the trip state up to date with the GPS trail (shared by the parent app and the admin map). */
export async function syncTrip(trackerId: string, fix: GpsFix, stops: Pt[], school: Pt | null, bus: BusTimings): Promise<TripState> {
  let st = await readState(trackerId);
  if (!st) {
    // first look at this bus: start from where it is now
    const inSchool = !!school && distanceKm(fix, school) < SCHOOL_KM;
    const t = Date.parse(fix.fixTime) || Date.now();
    st = { atSchool: inSchool, active: !inSchool, order: inSchool ? null : orderFromTimings(bus, t), confirmed: false, next: 0, lastT: 0, startedAt: t };
  }
  st = advance(st, await readTrail(trackerId, st.lastT), stops, school, bus);
  await writeState(trackerId, st);
  return st;
}

export type BusTrip = {
  phase: "AT_SCHOOL" | "ON_TRIP";
  trip: "PICKUP" | "DROP" | null; // pickup order (stop 1 first) or drop order; null = not known yet
  standingAt: string | null;      // stop it's standing at right now
  nextStop: string | null;        // where it's heading next
  done: number;                   // stops done on this trip
  total: number;
  reachedSchool: boolean;         // parked at school after a pickup trip
};

/** The bus's trip as a whole, for the admin live map (not tied to one child's stop). */
export async function busTrip(trackerId: string, fix: GpsFix, stops: (Pt & { name: string })[], school: Pt | null, bus: BusTimings): Promise<BusTrip | null> {
  if (!stops.length) return null;
  const st = await syncTrip(trackerId, fix, stops, school, bus);
  const standingAt = standingAtOf(st, fix, stops);
  if (!st.active) return { phase: "AT_SCHOOL", trip: null, standingAt: null, nextStop: null, done: 0, total: stops.length, reachedSchool: st.atSchool && st.ended?.order === "FORWARD" };
  const confirmed = confirmedOf(st);
  const list = st.order === "REVERSE" ? [...stops].reverse() : stops;
  return {
    phase: "ON_TRIP",
    trip: confirmed && st.order ? (st.order === "FORWARD" ? "PICKUP" : "DROP") : null,
    standingAt,
    // before the direction is known: heading to stop 1 or the last stop, can't say which yet
    nextStop: confirmed && st.order ? (st.next < list.length ? list[st.next].name : "School") : null,
    done: confirmed ? st.next : 0,
    total: stops.length,
    reachedSchool: false,
  };
}

export type StopEta = {
  etaMinutes: number | null;
  atStop: boolean;
  passedStop: boolean;
  stopsBefore: number | null; // stops the bus still visits before mine
  standingAt: string | null;  // name of the stop the bus is standing at right now (any stop)
  reachedSchool: boolean;     // pickup trip done: parked at school
};

/**
 * Where the bus is on today's trip relative to `myStopId`.
 * `stops` in route order (sequence asc). Call when the bus is online.
 */
export async function stopEta(
  trackerId: string, fix: GpsFix, stops: (Pt & { id: string; name: string })[], school: Pt | null, bus: BusTimings, myStopId: string,
): Promise<StopEta> {
  if (!stops.length) return NO_ETA;
  return etaFromState(await syncTrip(trackerId, fix, stops, school, bus), fix, stops, myStopId);
}

const NO_ETA: StopEta = { etaMinutes: null, atStop: false, passedStop: false, stopsBefore: null, standingAt: null, reachedSchool: false };

/** Same as stopEta, from an already up-to-date trip state (the alert engine checks many children at once). */
export function etaFromState(st: TripState, fix: GpsFix, stops: (Pt & { id: string; name: string })[], myStopId: string): StopEta {
  const none = NO_ETA;
  const mine = stops.find((s) => s.id === myStopId);
  if (!mine) return none;
  const here = distanceKm(fix, mine);
  const slow = fix.speedKmh < SLOW_KMH;
  // "At Patankar Park": the stop the bus is standing at right now
  const standingAt = standingAtOf(st, fix, stops);

  // parked at school: no trip running. After a pickup trip (stop 1 -> ... -> school, incl. the
  // combined midday trip) the children are at school now: say so.
  if (!st.active) return { ...none, reachedSchool: st.atSchool && st.ended?.order === "FORWARD" };
  if (!st.order || !confirmedOf(st)) {
    // it hasn't stopped at stop 1 / last stop yet, so we can't be sure which way it
    // goes (the timings are only a guess, and the test simulator ignores them):
    // no minutes (a guess here is what showed "1 min" while the
    // bus was only driving past). "At stop" only if it's really standing there.
    return { etaMinutes: null, atStop: here < AT_STOP_KM && slow, passedStop: false, stopsBefore: null, standingAt, reachedSchool: false };
  }
  const list = st.order === "FORWARD" ? stops : [...stops].reverse();
  const idx = list.findIndex((s) => s.id === myStopId);
  // just reached my stop (it's the one ticked off last) and still standing there
  if (st.next === idx + 1 && here < AT_STOP_KM) return { etaMinutes: 0, atStop: true, passedStop: false, stopsBefore: 0, standingAt, reachedSchool: false };
  if (st.next > idx) return { etaMinutes: null, atStop: false, passedStop: true, stopsBefore: null, standingAt, reachedSchool: false };
  let km = distanceKm(fix, list[st.next]);
  for (let k = st.next; k < idx; k++) km += distanceKm(list[k], list[k + 1]);
  const minutes = (km * ROAD_FACTOR / AVG_SPEED_KMH) * 60 + (idx - st.next) * DWELL_MIN;
  // before the direction is confirmed only trust "at stop" if the bus is actually standing there
  const atStop = st.next === idx && here < AT_STOP_KM && (confirmedOf(st) || slow);
  // minutes = from here through the stops still before mine. The app only shows them
  // once the stop just before mine is done (stopsBefore 0); until then it shows the count.
  return { etaMinutes: atStop ? 0 : Math.max(1, Math.round(minutes)), atStop, passedStop: false, stopsBefore: idx - st.next, standingAt, reachedSchool: false };
}
