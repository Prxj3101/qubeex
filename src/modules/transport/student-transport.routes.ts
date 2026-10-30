import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { academicDb } from "../../utils/academicContext";
import { etaMinutes, getFixes, isOnline } from "../../services/gps.service";

// Student / parent app: "My bus" — the child's bus, its route and stops, the
// child's stop, where the bus is right now and roughly when it will arrive.
// The app polls this every ~10 seconds while the screen is open.
const router = Router();
router.use(authMiddleware(["STUDENT"]), institutionAccessMiddleware, academicRoutingMiddleware);

router.get("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const student = await academicDb().student.findFirst({ where: { userId }, select: { id: true } });
    if (!student) {
      res.json({ success: true, data: null });
      return;
    }
    const ride = await academicDb().studentTransport.findUnique({
      where: { studentId: student.id },
      select: {
        stop: { select: { id: true, name: true, lat: true, lng: true, pickupTime: true } },
        bus: {
          select: {
            name: true, plateNumber: true, driverName: true, driverPhone: true, trackerId: true,
            route: { select: { name: true, color: true, stops: { orderBy: { sequence: "asc" }, select: { id: true, name: true, lat: true, lng: true, pickupTime: true } } } },
          },
        },
      },
    });
    if (!ride) {
      res.json({ success: true, data: null }); // not on any school bus
      return;
    }
    const fix = ride.bus.trackerId ? (await getFixes([ride.bus.trackerId])).get(ride.bus.trackerId) ?? null : null;
    const online = isOnline(fix);
    const { trackerId: _tracker, ...bus } = ride.bus;
    res.json({
      success: true,
      data: {
        bus,
        stop: ride.stop,
        position: fix,
        online,
        etaMinutes: online && fix && ride.stop ? etaMinutes(fix, ride.stop) : null,
        serverTime: new Date().toISOString(),
      },
    });
  } catch (err) { next(err); }
});

export default router;
