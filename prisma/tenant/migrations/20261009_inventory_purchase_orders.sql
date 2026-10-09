CREATE TABLE "InventoryPurchaseOrder" (
 "id" TEXT PRIMARY KEY, "institutionId" TEXT NOT NULL, "purchaseRequestId" TEXT NOT NULL,
 "number" TEXT NOT NULL, "supplierId" TEXT NOT NULL, "supplierSnapshot" JSONB NOT NULL,
 "locationId" TEXT NOT NULL, "locationName" TEXT NOT NULL, "expectedOn" DATE NOT NULL,
 "instructions" TEXT NOT NULL DEFAULT '', "lines" JSONB NOT NULL, "total" DECIMAL(14,2) NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING', "revision" INTEGER NOT NULL DEFAULT 1,
 "createdById" TEXT NOT NULL, "events" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "InventoryPurchaseOrder_purchaseRequestId_fkey" FOREIGN KEY ("purchaseRequestId") REFERENCES "InventoryPurchaseRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "InventoryPurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "InventorySupplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "InventoryPurchaseOrder_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "InventoryPurchaseOrder_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','PARTIALLY_RECEIVED','COMPLETED','CLOSED')),
 CONSTRAINT "InventoryPurchaseOrder_total_check" CHECK ("total" >= 0 AND "total" <= 1000000000 AND "revision" > 0 AND jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") BETWEEN 1 AND 20)
);
CREATE UNIQUE INDEX "InventoryPurchaseOrder_purchaseRequestId_key" ON "InventoryPurchaseOrder"("purchaseRequestId");
CREATE UNIQUE INDEX "InventoryPurchaseOrder_institutionId_number_key" ON "InventoryPurchaseOrder"("institutionId", "number");
CREATE INDEX "InventoryPurchaseOrder_institutionId_createdAt_idx" ON "InventoryPurchaseOrder"("institutionId", "createdAt");
ALTER TABLE "InventoryStockMovement" ADD COLUMN "purchaseOrderId" TEXT, ADD COLUMN "purchaseOrderLine" INTEGER;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "InventoryPurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_purchaseOrder_check" CHECK (("purchaseOrderId" IS NULL AND "purchaseOrderLine" IS NULL) OR ("purchaseOrderId" IS NOT NULL AND "purchaseOrderLine" >= 0 AND "purchaseOrderLine" IS NOT NULL AND "kind" = 'RECEIPT'));
CREATE INDEX "InventoryStockMovement_purchaseOrderId_idx" ON "InventoryStockMovement"("purchaseOrderId");
