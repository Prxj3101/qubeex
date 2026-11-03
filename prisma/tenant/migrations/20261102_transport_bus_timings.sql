-- Bus timings: morning / afternoon shift, each with a pickup time (bus leaves
-- the first stop) and a drop time (bus leaves school). Stop times are worked
-- out from these, so the per-stop pickup time is no longer typed by hand.
ALTER TABLE "TransportBus" ADD COLUMN IF NOT EXISTS "morningShift" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TransportBus" ADD COLUMN IF NOT EXISTS "morningPickup" TEXT NOT NULL DEFAULT '';
ALTER TABLE "TransportBus" ADD COLUMN IF NOT EXISTS "morningDrop" TEXT NOT NULL DEFAULT '';
ALTER TABLE "TransportBus" ADD COLUMN IF NOT EXISTS "afternoonShift" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TransportBus" ADD COLUMN IF NOT EXISTS "afternoonPickup" TEXT NOT NULL DEFAULT '';
ALTER TABLE "TransportBus" ADD COLUMN IF NOT EXISTS "afternoonDrop" TEXT NOT NULL DEFAULT '';

-- Which shift each student rides (existing riders: morning).
ALTER TABLE "StudentTransport" ADD COLUMN IF NOT EXISTS "shift" TEXT NOT NULL DEFAULT 'MORNING';

-- Keep what was already typed: a bus's morning pickup = its route's first stop time.
UPDATE "TransportBus" b
SET "morningPickup" = s."pickupTime"
FROM "TransportStop" s
WHERE b."routeId" = s."routeId"
  AND b."morningPickup" = ''
  AND s."pickupTime" <> ''
  AND s."sequence" = (SELECT MIN(s2."sequence") FROM "TransportStop" s2 WHERE s2."routeId" = b."routeId");
