CREATE TABLE "InventoryUnit" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InventoryUnit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryUnit_institutionId_nameKey_key" ON "InventoryUnit"("institutionId", "nameKey");
