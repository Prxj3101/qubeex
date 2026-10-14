ALTER TABLE "InventoryStockMovement" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMPTZ(3);
ALTER TABLE "InventoryStockMovement" ADD COLUMN IF NOT EXISTS "corrections" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "InventoryPurchaseRequest" DROP CONSTRAINT IF EXISTS "InventoryPurchaseRequest_status_check";
ALTER TABLE "InventoryPurchaseRequest" ADD CONSTRAINT "InventoryPurchaseRequest_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','CHANGES_REQUESTED','PARTIALLY_ISSUED','ISSUED'));
ALTER TABLE "InventoryPurchaseRequest" DROP CONSTRAINT IF EXISTS "InventoryPurchaseRequest_source_check";
ALTER TABLE "InventoryPurchaseRequest" ADD CONSTRAINT "InventoryPurchaseRequest_source_check" CHECK ("source" IN ('MANUAL','TEACHER','ITEM_REQUEST_PURCHASE'));
