import { distanceKm } from "./gps.service";

// Rough timetable for a bus trip, worked out from the stops' positions so the
// admin only types when the bus starts. Parents get the live GPS ETA anyway;
// these times are just the plan ("around 06:35").
// Every trip starts at school (the time the admin types = bus leaves school):
//   Pickup trip: school -> first stop -> ... -> last stop -> school
//   Drop trip:   school -> last stop -> ... -> first stop (reverse order)
// Combined midday trip: when the morning drop and afternoon pickup leave school
// at the same time, it's one trip (children get off and on at each stop), so
// the morning drop follows the pickup order and both get the same stop times.

const ROAD_FACTOR = 1.35; // roads aren't straight lines
const AVG_SPEED_KMH = 20; // school bus in town, with traffic
const DWELL_MIN = 1; // time spent at each stop

export type Shift = "MORNING" | "AFTERNOON";
type Point = { lat: number; lng: number };
type StopPoint = Point & { id: string };

const legMinutes = (a: Point, b: Point) => (distanceKm(a, b) * ROAD_FACTOR / AVG_SPEED_KMH) * 60;

const toMinutes = (hhmm: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const toHHMM = (mins: number) => {
  const t = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/** Morning drop and afternoon pickup leave school together: one combined trip. */
export const isCombinedMidday = (bus: { morningShift: boolean; afternoonShift: boolean; morningDrop: string; afternoonPickup: string }) =>
  bus.morningShift && bus.afternoonShift && !!bus.morningDrop && bus.morningDrop === bus.afternoonPickup;

/** Estimated time at each stop (by stop id) for a trip starting at `start` (HH:MM). `combined`: a drop on the combined midday trip (pickup order). */
export function stopTimes(stops: StopPoint[], school: Point | null, start: string, kind: "PICKUP" | "DROP", combined = false): Map<string, string> {
  const out = new Map<string, string>();
  const t0 = toMinutes(start);
  if (t0 == null || !stops.length) return out;
  const order = kind === "PICKUP" || combined ? stops : [...stops].reverse();
  let t = t0;
  let prev: Point | null = school; // no school set yet: times count from the first stop
  order.forEach((s, i) => {
    if (prev) t += legMinutes(prev, s) + (i > 0 ? DWELL_MIN : 0);
    out.set(s.id, toHHMM(t));
    prev = s;
  });
  return out;
}
