ALTER TABLE "InventoryStockMovement" ADD COLUMN "deliveredQuantity" DECIMAL(14,3), ADD COLUMN "rejectedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0, ADD COLUMN "damageReason" TEXT NOT NULL DEFAULT '';
UPDATE "InventoryStockMovement" SET "deliveredQuantity" = "quantity" WHERE "kind" = 'RECEIPT';
ALTER TABLE "InventoryStockMovement" DROP CONSTRAINT "InventoryStockMovement_quantity_check";
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_quantity_check" CHECK ("quantity" > 0 OR ("kind" = 'RECEIPT' AND "quantity" = 0));
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_receipt_acceptance_check" CHECK ("kind" <> 'RECEIPT' OR ("deliveredQuantity" IS NOT NULL AND "deliveredQuantity" > 0 AND "rejectedQuantity" >= 0 AND "rejectedQuantity" <= "deliveredQuantity" AND "quantity" = "deliveredQuantity" - "rejectedQuantity" AND (("rejectedQuantity" = 0 AND "damageReason" = '') OR ("rejectedQuantity" > 0 AND length(trim("damageReason")) > 0))));
