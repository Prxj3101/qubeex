-- Transport: live GPS bus tracking (routes, stops, buses, student assignments)
-- and the central tracker-id registry.

CREATE TABLE "GpsTracker" (
    "trackerId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GpsTracker_pkey" PRIMARY KEY ("trackerId")
);
CREATE INDEX "GpsTracker_institutionId_idx" ON "GpsTracker"("institutionId");
ALTER TABLE "GpsTracker" ADD CONSTRAINT "GpsTracker_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TransportRoute" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#DA7756',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TransportRoute_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TransportRoute_institutionId_nameKey_key" ON "TransportRoute"("institutionId", "nameKey");
ALTER TABLE "TransportRoute" ADD CONSTRAINT "TransportRoute_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TransportStop" (
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
CREATE INDEX "TransportStop_routeId_sequence_idx" ON "TransportStop"("routeId", "sequence");
ALTER TABLE "TransportStop" ADD CONSTRAINT "TransportStop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "TransportRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TransportBus" (
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
CREATE UNIQUE INDEX "TransportBus_institutionId_nameKey_key" ON "TransportBus"("institutionId", "nameKey");
CREATE UNIQUE INDEX "TransportBus_trackerId_key" ON "TransportBus"("trackerId");
ALTER TABLE "TransportBus" ADD CONSTRAINT "TransportBus_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransportBus" ADD CONSTRAINT "TransportBus_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "TransportRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "StudentTransport" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "stopId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StudentTransport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StudentTransport_studentId_key" ON "StudentTransport"("studentId");
CREATE INDEX "StudentTransport_busId_idx" ON "StudentTransport"("busId");
ALTER TABLE "StudentTransport" ADD CONSTRAINT "StudentTransport_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentTransport" ADD CONSTRAINT "StudentTransport_busId_fkey" FOREIGN KEY ("busId") REFERENCES "TransportBus"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentTransport" ADD CONSTRAINT "StudentTransport_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "TransportStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
