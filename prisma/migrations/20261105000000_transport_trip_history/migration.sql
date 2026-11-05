-- Trip history: one row per bus trip (pickup / drop), filled in from the GPS
-- as the trip happens (Admin -> Transport -> History).
CREATE TABLE IF NOT EXISTS "TransportTrip" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "busId" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "stops" JSONB NOT NULL DEFAULT '[]',
  "maxSpeedKmh" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TransportTrip_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TransportTrip_busId_fkey" FOREIGN KEY ("busId") REFERENCES "TransportBus"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TransportTrip_busId_startedAt_key" ON "TransportTrip"("busId", "startedAt");
CREATE INDEX IF NOT EXISTS "TransportTrip_institutionId_day_idx" ON "TransportTrip"("institutionId", "day");
