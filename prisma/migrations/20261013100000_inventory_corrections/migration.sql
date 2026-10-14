ALTER TABLE "InventoryStockMovement" ADD COLUMN IF NOT EXISTS "corrections" JSONB NOT NULL DEFAULT '[]'::jsonb;
