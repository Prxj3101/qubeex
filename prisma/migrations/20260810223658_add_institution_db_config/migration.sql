-- BYOD Phase 1: per-institution data-storage configuration (central DB).
CREATE TABLE "InstitutionDbConfig" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'MANAGED',
    "engine" TEXT,
    "host" TEXT,
    "port" INTEGER,
    "databaseName" TEXT,
    "username" TEXT,
    "passwordCipher" TEXT,
    "passwordIv" TEXT,
    "passwordTag" TEXT,
    "sslMode" TEXT DEFAULT 'require',
    "sslCaCert" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastTestedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "provisionedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InstitutionDbConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstitutionDbConfig_institutionId_key" ON "InstitutionDbConfig"("institutionId");

ALTER TABLE "InstitutionDbConfig"
  ADD CONSTRAINT "InstitutionDbConfig_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
