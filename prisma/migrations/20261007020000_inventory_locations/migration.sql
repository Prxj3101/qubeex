CREATE TABLE "InventoryLocation" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InventoryLocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryLocation_institutionId_nameKey_key" ON "InventoryLocation"("institutionId", "nameKey");
ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
