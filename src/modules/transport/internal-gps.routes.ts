import express, { Router, Request, Response } from "express";
import { forgetTrackerCache, saveFix, trackerInstitution } from "../../services/gps.service";

// Traccar (running next to the backend on the server) forwards every decoded GPS
// position here, as JSON: { position: {...}, device: { uniqueId, ... } }.
//
// This endpoint is for Traccar only. Caddy refuses /api/internal/* from the
// internet, and as a second lock we refuse anything that came through a proxy
// (Caddy always adds X-Forwarded-For; Traccar talks to backend:3000 directly).
const router = Router();

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

router.post("/gps", express.json({ limit: "64kb" }), async (req: Request, res: Response) => {
  if (req.headers["x-forwarded-for"]) {
    res.status(404).end();
    return;
  }
  try {
    const body = req.body as { position?: Record<string, unknown>; device?: Record<string, unknown> } | undefined;
    const trackerId = typeof body?.device?.uniqueId === "string" ? body.device.uniqueId.trim() : "";
    const p = body?.position ?? {};
    const lat = num(p.latitude);
    const lng = num(p.longitude);
    // 2xx even when we ignore it, so Traccar doesn't keep retrying
    if (!trackerId || lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      res.status(204).end();
      return;
    }
    // Only keep positions of trackers that a school has added to a bus
    if (!(await trackerInstitution(trackerId))) {
      res.status(204).end();
      return;
    }
    const rawTime = typeof p.fixTime === "string" ? p.fixTime : typeof p.deviceTime === "string" ? p.deviceTime : null;
    const fixTime = rawTime && !Number.isNaN(Date.parse(rawTime)) ? new Date(rawTime).toISOString() : new Date().toISOString();
    await saveFix(trackerId, {
      lat,
      lng,
      speedKmh: Math.round((num(p.speed) ?? 0) * 1.852 * 10) / 10, // Traccar sends knots
      course: Math.round(num(p.course) ?? 0),
      fixTime,
      receivedAt: new Date().toISOString(),
    });
    res.status(204).end();
  } catch (err) {
    console.error("[gps] forward failed", err);
    forgetTrackerCache();
    res.status(204).end();
  }
});

export default router;
