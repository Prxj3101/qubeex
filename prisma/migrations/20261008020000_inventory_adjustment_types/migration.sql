ALTER TABLE "InventoryStockMovement" ADD COLUMN "adjustmentType" TEXT;
UPDATE "InventoryStockMovement" SET "adjustmentType" = 'COUNT_CORRECTION' WHERE "kind" = 'ADJUSTMENT';
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_adjustment_type_check" CHECK ("kind" <> 'ADJUSTMENT' OR ("adjustmentType" IS NOT NULL AND "adjustmentType" IN ('COUNT_CORRECTION', 'DAMAGED', 'LOST') AND ("adjustmentType" = 'COUNT_CORRECTION' OR "correctedQuantity" < "previousQuantity")));
