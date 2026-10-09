CREATE TABLE "InventorySupplier" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "contactPerson" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InventorySupplier_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventorySupplier_institutionId_nameKey_key" ON "InventorySupplier"("institutionId", "nameKey");
ALTER TABLE "InventorySupplier" ADD CONSTRAINT "InventorySupplier_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
