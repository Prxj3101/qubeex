import { distanceKm, saveFix } from "./gps.service";
import { pushTrail } from "./tripProgress";

// Demo buses, started from the admin Transport page ("Start demo").
//
// Same idea as scripts/bus-sim.mjs, but running inside the backend so a demo on
// qubeex.in needs nothing on anyone's laptop: every bus whose GPS tracker id
// starts with "sim-" drives its own route on real roads, in order, pickup ->
// drop -> pickup ... and stops at each stop for a little while. Positions are
// written exactly like a real tracker's (latest fix + trail), so the admin map
// and the parent app can't tell the difference.
//
// Only "sim-" buses are ever moved, so real buses of a school are never touched.
// A demo stops by itself after DEMO_MINUTES, or with "Stop demo".

export const SIM_PREFIX = "sim-";
const DEMO_MINUTES = 45;
const TICK_S = 3;            // how often a position is "sent"
const SCHOOL_WAIT_S = 25;    // parked at school between trips
const STOP_WAIT_S = [15, 30];// waiting at a stop (min, max)

type Pt = { lat: number; lng: number };
type Named = Pt & { name: string };
export type DemoBus = { trackerId: string; name: string; stops: Named[] };

type Demo = { startedAt: number; endsAt: number; stop: () => void; buses: string[] };
const running = new Map<string, Demo>(); // by institution

export function demoStatus(institutionId: string) {
  const d = running.get(institutionId);
  return d ? { running: true, startedAt: new Date(d.startedAt).toISOString(), endsAt: new Date(d.endsAt).toISOString(), buses: d.buses } : { running: false };
}

export function stopDemo(institutionId: string) {
  running.get(institutionId)?.stop();
  running.delete(institutionId);
}

// ── roads (free OSRM demo server; straight line if it can't be reached) ─────
const roadCache = new Map<string, Pt[]>();
async function roadPath(a: Pt, b: Pt): Promise<Pt[]> {
  const key = `${a.lat},${a.lng};${b.lat},${b.lng}`;
  const hit = roadCache.get(key);
  if (hit) return hit;
  let path: Pt[] = [a, b];
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
    const r = await fetch(url, { headers: { "User-Agent": "qubeex-demo-buses" }, signal: AbortSignal.timeout(6000) });
    const j = (await r.json()) as { routes?: { geometry?: { coordinates?: [number, number][] } }[] };
    const coords = j.routes?.[0]?.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) path = [a, ...coords.map(([lng, lat]) => ({ lat, lng })), b];
  } catch { /* straight line */ }
  if (roadCache.size > 500) roadCache.clear();
  roadCache.set(key, path);
  return path;
}

const bearing = (a: Pt, b: Pt) => {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

/** Start (or restart) the demo for a school. `school` = where every trip starts and ends. */
export function startDemo(institutionId: string, school: Pt, buses: DemoBus[]) {
  stopDemo(institutionId);
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sleep = (ms: number) => new Promise<void>((res) => { const t = setTimeout(() => { timers.delete(t); res(); }, ms); timers.add(t); });

  const send = async (trackerId: string, p: Pt, speedKmh: number, course: number) => {
    if (stopped) return;
    const now = new Date().toISOString();
    const fix = { lat: p.lat, lng: p.lng, speedKmh: Math.round(speedKmh * 10) / 10, course: Math.round(course), fixTime: now, receivedAt: now };
    await saveFix(trackerId, fix);
    await pushTrail(trackerId, fix);
  };

  const drive = async (bus: DemoBus, index: number) => {
    const home: Named = { ...school, name: "School" };
    let pos: Pt = { ...school };
    let course = 90;
    let kind: "PICKUP" | "DROP" = "PICKUP";
    await sleep(index * 4000); // buses leave a little apart
    while (!stopped) {
      // parked at school
      for (let s = 0; s < SCHOOL_WAIT_S && !stopped; s += TICK_S) { await send(bus.trackerId, pos, 0, course); await sleep(TICK_S * 1000); }
      const order = kind === "PICKUP" ? bus.stops : [...bus.stops].reverse();
      const points: Named[] = [home, ...order, home];
      for (let li = 0; li < points.length - 1 && !stopped; li++) {
        const to = points[li + 1];
        const path = await roadPath(points[li], to);
        const cruise = 18 + Math.random() * 12;
        // walk the path TICK_S seconds at a time
        let i = 0;
        let along = 0; // km travelled on segment i
        while (i < path.length - 1 && !stopped) {
          const left = distanceKm(pos, to);
          const speed = left < 0.12 ? Math.max(8, cruise * 0.45) : cruise * (0.85 + Math.random() * 0.3);
          let step = (speed / 3600) * TICK_S;
          while (step > 0 && i < path.length - 1) {
            const seg = distanceKm(path[i], path[i + 1]);
            if (along + step < seg) { along += step; step = 0; }
            else { step -= seg - along; along = 0; i++; }
          }
          if (i >= path.length - 1) pos = { lat: to.lat, lng: to.lng };
          else {
            const a = path[i], b = path[i + 1], seg = distanceKm(a, b) || 1;
            const t = along / seg;
            pos = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
            course = bearing(a, b);
          }
          await send(bus.trackerId, pos, i >= path.length - 1 ? 0 : speed, course);
          await sleep(TICK_S * 1000);
        }
        if (li < points.length - 2) {
          // at a stop: children get on / off
          const wait = STOP_WAIT_S[0] + Math.random() * (STOP_WAIT_S[1] - STOP_WAIT_S[0]);
          for (let s = 0; s < wait && !stopped; s += TICK_S) { await send(bus.trackerId, pos, 0, course); await sleep(TICK_S * 1000); }
        }
      }
      kind = kind === "PICKUP" ? "DROP" : "PICKUP";
    }
  };

  const startedAt = Date.now();
  const endsAt = startedAt + DEMO_MINUTES * 60_000;
  const stop = () => { stopped = true; timers.forEach(clearTimeout); };
  timers.add(setTimeout(() => stopDemo(institutionId), DEMO_MINUTES * 60_000));
  running.set(institutionId, { startedAt, endsAt, stop, buses: buses.map((b) => b.name) });
  buses.forEach((b, i) => { drive(b, i).catch((err) => console.error("[bus-demo]", b.name, err)); });
  return demoStatus(institutionId);
}
