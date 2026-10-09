ALTER TABLE "InventoryStockMovement" DROP CONSTRAINT "InventoryStockMovement_return_details_check";
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_return_details_check" CHECK (("kind" IN ('RETURN','ISSUE_DAMAGED','ISSUE_LOST') AND "issueId" IS NOT NULL AND "requestId" IS NOT NULL) OR ("kind" NOT IN ('RETURN','ISSUE_DAMAGED','ISSUE_LOST') AND "issueId" IS NULL));
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_issue_resolution_reason_check" CHECK ("kind" NOT IN ('ISSUE_DAMAGED','ISSUE_LOST') OR length(trim("notes")) > 0);
