CREATE TABLE "InventoryPurchaseRequest" (
 "id" TEXT NOT NULL PRIMARY KEY, "institutionId" TEXT NOT NULL,
 "requestId" TEXT NOT NULL, "source" TEXT NOT NULL DEFAULT 'MANUAL',
 "requestedById" TEXT, "requestedByName" TEXT NOT NULL, "department" TEXT NOT NULL DEFAULT '',
 "reason" TEXT NOT NULL, "requiredOn" DATE NOT NULL, "lines" JSONB NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING', "revision" INTEGER NOT NULL DEFAULT 1,
 "createdById" TEXT NOT NULL, "events" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "InventoryPurchaseRequest_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','CHANGES_REQUESTED')),
 CONSTRAINT "InventoryPurchaseRequest_source_check" CHECK ("source" IN ('MANUAL','TEACHER')),
 CONSTRAINT "InventoryPurchaseRequest_details_check" CHECK (length(trim("requestedByName")) > 0 AND length(trim("reason")) > 0 AND "revision" > 0 AND jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") BETWEEN 1 AND 20)
);
CREATE UNIQUE INDEX "InventoryPurchaseRequest_institutionId_requestId_key" ON "InventoryPurchaseRequest"("institutionId", "requestId");
CREATE INDEX "InventoryPurchaseRequest_institutionId_createdAt_idx" ON "InventoryPurchaseRequest"("institutionId", "createdAt");
