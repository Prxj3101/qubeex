import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { getFixes, isOnline } from "../../services/gps.service";
import { stopEta } from "../../services/tripProgress";
import { BUS_ALERTS_KEY, forgetBusAlertCache } from "../../services/busAlerts.service";
import { isCombinedMidday, stopTimes, type Shift } from "../../services/transportSchedule";

// Student / parent app: "My bus" — the child's bus, its route and stops, the
// child's stop, where the bus is right now and roughly when it will arrive.
// The app polls this every ~10 seconds while the screen is open.
const router = Router();
router.use(authMiddleware(["STUDENT"]), institutionAccessMiddleware, academicRoutingMiddleware);

router.get("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const student = await academicDb().student.findFirst({ where: { userId }, select: { id: true, extraDetailFields: true } });
    if (!student) {
      res.json({ success: true, data: null });
      return;
    }
    const ride = await academicDb().studentTransport.findUnique({
      where: { studentId: student.id },
      select: {
        shift: true,
        stop: { select: { id: true, name: true, lat: true, lng: true } },
        bus: {
          select: {
            name: true, plateNumber: true, driverName: true, driverPhone: true, trackerId: true,
            morningShift: true, afternoonShift: true, morningPickup: true, morningDrop: true, afternoonPickup: true, afternoonDrop: true,
            route: { select: { name: true, color: true, stops: { orderBy: { sequence: "asc" }, select: { id: true, name: true, lat: true, lng: true } } } },
          },
        },
      },
    });
    if (!ride) {
      res.json({ success: true, data: null }); // not on any school bus
      return;
    }
    const inst = req.user?.institutionId
      ? await prisma.institution.findUnique({ where: { id: req.user.institutionId }, select: { name: true, schoolLat: true, schoolLng: true } })
      : null;
    const school = inst?.schoolLat != null && inst.schoolLng != null ? { name: inst.name, lat: inst.schoolLat, lng: inst.schoolLng } : null;
    const fix = ride.bus.trackerId ? (await getFixes([ride.bus.trackerId])).get(ride.bus.trackerId) ?? null : null;
    const online = isOnline(fix);
    // planned times for the child's shift: pickup trip (to school) and drop trip (home)
    const shift = (ride.shift === "AFTERNOON" ? "AFTERNOON" : "MORNING") as Shift;
    const combined = shift === "MORNING" && isCombinedMidday(ride.bus); // morning drop rides the combined midday trip
    const { trackerId: _tracker, morningShift: _m, afternoonShift: _a, morningPickup, morningDrop, afternoonPickup, afternoonDrop, route, ...busInfo } = ride.bus;
    const pickupStart = shift === "AFTERNOON" ? afternoonPickup : morningPickup;
    const dropStart = shift === "AFTERNOON" ? afternoonDrop : morningDrop;
    const routeStops = route?.stops ?? [];
    const pickupTimes = stopTimes(routeStops, school, pickupStart, "PICKUP");
    const dropTimes = stopTimes(routeStops, school, dropStart, "DROP", combined);
    const withTimes = <T extends { id: string }>(s: T) => ({ ...s, pickupAt: pickupTimes.get(s.id) ?? null, dropAt: dropTimes.get(s.id) ?? null });
    const bus = { ...busInfo, route: route ? { ...route, stops: routeStops.map(withTimes) } : null };
    const live = online && fix && ride.stop && ride.bus.trackerId
      ? await stopEta(ride.bus.trackerId, fix, routeStops, school, ride.bus, ride.stop.id)
      : { etaMinutes: null, atStop: false, passedStop: false, stopsBefore: null, standingAt: null, reachedSchool: false };
    res.json({
      success: true,
      data: {
        bus,
        shift,
        trip: { pickupStart: pickupStart || null, dropStart: dropStart || null },
        stop: ride.stop ? withTimes(ride.stop) : null,
        school,
        position: fix,
        online,
        // route-aware: follows the trip stop by stop (see tripProgress.ts)
        ...live,
        // phone alerts ("bus is 2 min away", "reached school"); parents can switch them off
        alertsOn: ((student.extraDetailFields ?? {}) as Record<string, unknown>)[BUS_ALERTS_KEY] !== "off",
        serverTime: new Date().toISOString(),
      },
    });
  } catch (err) { next(err); }
});

// Bus alerts on / off for this child
router.put("/alerts", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const on = (req.body as { on?: unknown })?.on;
    if (typeof on !== "boolean") { res.status(400).json({ success: false, message: "on must be true or false" }); return; }
    const student = await academicDb().student.findFirst({ where: { userId: req.user!.userId }, select: { id: true, extraDetailFields: true } });
    if (!student) { res.status(404).json({ success: false, message: "Student not found" }); return; }
    const fields = { ...((student.extraDetailFields ?? {}) as Record<string, unknown>) };
    if (on) delete fields[BUS_ALERTS_KEY];
    else fields[BUS_ALERTS_KEY] = "off";
    await academicDb().student.update({ where: { id: student.id }, data: { extraDetailFields: fields as object } });
    forgetBusAlertCache();
    res.json({ success: true, data: { alertsOn: on } });
  } catch (err) { next(err); }
});

export default router;
