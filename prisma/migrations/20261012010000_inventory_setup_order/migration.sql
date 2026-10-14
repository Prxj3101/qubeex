CREATE TABLE "InventorySetupOrder" (
 "institutionId" TEXT NOT NULL, "kind" TEXT NOT NULL, "ids" JSONB NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 1, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "InventorySetupOrder_pkey" PRIMARY KEY ("institutionId", "kind"),
 CONSTRAINT "InventorySetupOrder_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "InventorySetupOrder_kind_check" CHECK ("kind" IN ('categories','units','locations','suppliers')),
 CONSTRAINT "InventorySetupOrder_details_check" CHECK (jsonb_typeof("ids") = 'array' AND "revision" > 0)
);
