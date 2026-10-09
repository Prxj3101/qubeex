CREATE TABLE "InventoryCategory" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InventoryCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryCategory_institutionId_nameKey_key" ON "InventoryCategory"("institutionId", "nameKey");
ALTER TABLE "InventoryCategory" ADD CONSTRAINT "InventoryCategory_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
