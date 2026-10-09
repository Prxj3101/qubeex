CREATE TYPE "InventoryItemType" AS ENUM ('CONSUMABLE', 'RETURNABLE', 'FIXED_ASSET');
CREATE TABLE "InventoryItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "institutionId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "type" "InventoryItemType" NOT NULL,
  "categoryId" TEXT NOT NULL,
  "unitId" TEXT NOT NULL,
  "lowStockLevel" DECIMAL(14,3) NOT NULL DEFAULT 0 CHECK ("lowStockLevel" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "InventoryStockBalance" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "institutionId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL CHECK ("quantity" >= 0),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "InventoryStockMovement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "institutionId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL CHECK ("quantity" > 0),
  "recordedOn" DATE NOT NULL,
  "notes" TEXT NOT NULL DEFAULT '',
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "InventoryItem_institutionId_code_key" ON "InventoryItem"("institutionId", "code");
CREATE INDEX "InventoryItem_institutionId_name_idx" ON "InventoryItem"("institutionId", "name");
CREATE UNIQUE INDEX "InventoryStockBalance_itemId_locationId_key" ON "InventoryStockBalance"("itemId", "locationId");
CREATE INDEX "InventoryStockBalance_institutionId_idx" ON "InventoryStockBalance"("institutionId");
CREATE INDEX "InventoryStockMovement_institutionId_itemId_createdAt_idx" ON "InventoryStockMovement"("institutionId", "itemId", "createdAt");
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryStockBalance" ADD CONSTRAINT "InventoryStockBalance_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "InventoryCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "InventoryUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockBalance" ADD CONSTRAINT "InventoryStockBalance_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockBalance" ADD CONSTRAINT "InventoryStockBalance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
