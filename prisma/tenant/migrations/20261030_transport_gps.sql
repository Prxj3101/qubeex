-- Transport: live GPS bus tracking (BYOD tenant). Mirrors TransportRoute, TransportStop,
-- TransportBus, StudentTransport. GpsTracker stays central. No FKs to platform tables.

CREATE TABLE IF NOT EXISTS "TransportRoute" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#DA7756',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TransportRoute_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TransportRoute_institutionId_nameKey_key" ON "TransportRoute"("institutionId", "nameKey");

CREATE TABLE IF NOT EXISTS "TransportStop" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "sequence" INTEGER NOT NULL,
    "pickupTime" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransportStop_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TransportStop_routeId_sequence_idx" ON "TransportStop"("routeId", "sequence");
ALTER TABLE "TransportStop" ADD CONSTRAINT "TransportStop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "TransportRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "TransportBus" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL DEFAULT '',
    "trackerId" TEXT,
    "driverName" TEXT NOT NULL DEFAULT '',
    "driverPhone" TEXT NOT NULL DEFAULT '',
    "capacity" INTEGER,
    "routeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TransportBus_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TransportBus_institutionId_nameKey_key" ON "TransportBus"("institutionId", "nameKey");
CREATE UNIQUE INDEX IF NOT EXISTS "TransportBus_trackerId_key" ON "TransportBus"("trackerId");
ALTER TABLE "TransportBus" ADD CONSTRAINT "TransportBus_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "TransportRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "StudentTransport" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "stopId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StudentTransport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StudentTransport_studentId_key" ON "StudentTransport"("studentId");
CREATE INDEX IF NOT EXISTS "StudentTransport_busId_idx" ON "StudentTransport"("busId");
ALTER TABLE "StudentTransport" ADD CONSTRAINT "StudentTransport_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentTransport" ADD CONSTRAINT "StudentTransport_busId_fkey" FOREIGN KEY ("busId") REFERENCES "TransportBus"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentTransport" ADD CONSTRAINT "StudentTransport_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "TransportStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

