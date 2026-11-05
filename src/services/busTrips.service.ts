import { getAcademicClient } from "./tenantDb.service";
import { isCombinedMidday, stopTimes } from "./transportSchedule";
import type { BusTimings, EndedTrip, Reached, TripState } from "./tripProgress";

// Trip history: turns the live trip state (tripProgress.ts) into one
// TransportTrip row per trip, upserted as the trip goes (left school, each stop
// reached, back at school). Admin -> Transport -> History reads these.

type Pt = { lat: number; lng: number };
type Stop = Pt & { id: string; name: string };
export type TripStop = { stopId: string; name: string; plannedAt: string | null; reachedAt: string | null };

const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const IST_HM = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
export const istDay = (t: number | Date) => IST_DAY.format(t); // YYYY-MM-DD
const istMinutes = (t: number) => { const [h, m] = IST_HM.format(t).split(":").map(Number); return h * 60 + m; };
const hhmm = (s: string) => { const m = /^(\d{2}):(\d{2})$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** The timetable start ("bus leaves school") closest to when this trip really started, for the planned stop times. */
function scheduledStart(b: BusTimings, kind: "PICKUP" | "DROP", startedAt: number): { at: string; combined: boolean } | null {
  const combined = isCombinedMidday(b);
  const options: { at: string; combined: boolean }[] = [];
  if (kind === "PICKUP") {
    if (b.morningShift && b.morningPickup) options.push({ at: b.morningPickup, combined: false });
    if (b.afternoonShift && b.afternoonPickup) options.push({ at: b.afternoonPickup, combined: false });
  } else {
    if (b.morningShift && b.morningDrop && !combined) options.push({ at: b.morningDrop, combined: false });
    if (b.afternoonShift && b.afternoonDrop) options.push({ at: b.afternoonDrop, combined: false });
  }
  const now = istMinutes(startedAt);
  let best: { gap: number; o: { at: string; combined: boolean } } | null = null;
  for (const o of options) {
    const v = hhmm(o.at);
    if (v == null) continue;
    const gap = Math.abs(now - v);
    if (gap <= 120 && (!best || gap < best.gap)) best = { gap, o };
  }
  return best?.o ?? null;
}

function snapshot(
  kindOrder: "FORWARD" | "REVERSE" | null, startedAt: number, endedAt: number | null, reached: Reached[], vmax: number,
  stops: Stop[], school: Pt | null, timings: BusTimings,
) {
  const kind = kindOrder === "FORWARD" ? "PICKUP" : kindOrder === "REVERSE" ? "DROP" : "UNKNOWN";
  const sched = kind === "UNKNOWN" ? null : scheduledStart(timings, kind, startedAt);
  const planned = sched ? stopTimes(stops, school, sched.at, kind === "PICKUP" ? "PICKUP" : "DROP", sched.combined) : new Map<string, string>();
  const order = kindOrder === "REVERSE" ? [...stops].reverse() : stops;
  const at = new Map(reached.map((r) => [r.s, r.t]));
  const list: TripStop[] = order.map((s) => {
    const pos = stops.findIndex((x) => x.id === s.id);
    const t = at.get(pos);
    return { stopId: s.id, name: s.name, plannedAt: planned.get(s.id) ?? null, reachedAt: t ? new Date(t).toISOString() : null };
  });
  return { kind, startedAt, endedAt, stops: list, maxSpeedKmh: Math.round(vmax) };
}

const written = new Map<string, string>(); // what we last wrote per trip, to skip no-op writes

async function save(institutionId: string, busId: string, snap: ReturnType<typeof snapshot>) {
  const key = `${busId}:${snap.startedAt}`;
  const body = JSON.stringify(snap);
  if (written.get(key) === body) return;
  const db = await getAcademicClient(institutionId);
  const data = {
    kind: snap.kind,
    endedAt: snap.endedAt ? new Date(snap.endedAt) : null,
    stops: snap.stops as unknown as object,
    maxSpeedKmh: snap.maxSpeedKmh,
  };
  await db.transportTrip.upsert({
    where: { busId_startedAt: { busId, startedAt: new Date(snap.startedAt) } },
    update: data,
    create: { institutionId, busId, day: istDay(snap.startedAt), startedAt: new Date(snap.startedAt), ...data },
  });
  written.set(key, body);
  if (written.size > 2000) written.clear();
}

/** Write the running trip and the one that just finished (both idempotent). Never throws. */
export async function recordTrips(
  institutionId: string, busId: string, st: TripState, stops: Stop[], school: Pt | null, timings: BusTimings,
): Promise<void> {
  try {
    if (!stops.length) return;
    if (st.active) {
      await save(institutionId, busId, snapshot(st.confirmed || st.next > 0 ? st.order : null, st.startedAt, null, st.reached ?? [], st.vmax ?? 0, stops, school, timings));
    }
    const e: EndedTrip | undefined = st.ended;
    if (e?.startedAt && Date.now() - e.at < 24 * 3600_000) {
      await save(institutionId, busId, snapshot(e.order, e.startedAt, e.at, e.reached ?? [], e.vmax ?? 0, stops, school, timings));
    }
  } catch (err) {
    console.error("[bus-trips]", (err as Error).message);
  }
}
