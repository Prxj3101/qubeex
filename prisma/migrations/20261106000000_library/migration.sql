-- Library module (central DB, managed institutions). Same tables as prisma/tenant/migrations/20261106_library.sql.
-- NOT yet applied: run it yourself (e.g. prisma migrate deploy, or paste into the Supabase SQL editor).
CREATE TABLE IF NOT EXISTS "LibrarySettings" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "finesMode" TEXT NOT NULL DEFAULT 'OFF',
  "rulesConfigured" BOOLEAN NOT NULL DEFAULT false,
  "dueSoonDays" INTEGER NOT NULL DEFAULT 2,
  "lostChargePaise" INTEGER NOT NULL DEFAULT 0,
  "damagedChargePaise" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LibrarySettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "LibrarySettings_institutionId_key" ON "LibrarySettings"("institutionId");

CREATE TABLE IF NOT EXISTS "LibraryRule" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "borrowerType" TEXT NOT NULL,
  "maxBooks" INTEGER NOT NULL,
  "loanDays" INTEGER NOT NULL,
  "maxRenewals" INTEGER NOT NULL,
  "finePerDayPaise" INTEGER NOT NULL,
  "graceDays" INTEGER NOT NULL,
  "fineCapPaise" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LibraryRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "LibraryRule_institutionId_borrowerType_key" ON "LibraryRule"("institutionId", "borrowerType");
CREATE INDEX IF NOT EXISTS "LibraryRule_institutionId_idx" ON "LibraryRule"("institutionId");

CREATE TABLE IF NOT EXISTS "LibraryBook" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "author" TEXT,
  "isbn" TEXT,
  "category" TEXT,
  "language" TEXT,
  "shelf" TEXT,
  "pricePaise" INTEGER,
  "coverUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LibraryBook_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "LibraryBook_institutionId_idx" ON "LibraryBook"("institutionId");
CREATE INDEX IF NOT EXISTS "LibraryBook_institutionId_isbn_idx" ON "LibraryBook"("institutionId", "isbn");

CREATE TABLE IF NOT EXISTS "LibraryCopy" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "accessionCode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LibraryCopy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LibraryCopy_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "LibraryBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "LibraryCopy_institutionId_accessionCode_key" ON "LibraryCopy"("institutionId", "accessionCode");
CREATE INDEX IF NOT EXISTS "LibraryCopy_institutionId_idx" ON "LibraryCopy"("institutionId");
CREATE INDEX IF NOT EXISTS "LibraryCopy_bookId_idx" ON "LibraryCopy"("bookId");

CREATE TABLE IF NOT EXISTS "LibraryLoan" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "copyId" TEXT NOT NULL,
  "borrowerUserId" TEXT NOT NULL,
  "borrowerType" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "returnedAt" TIMESTAMP(3),
  "renewals" INTEGER NOT NULL DEFAULT 0,
  "issuedById" TEXT NOT NULL,
  "returnedById" TEXT,
  "lastRemindedAt" TIMESTAMP(3),
  CONSTRAINT "LibraryLoan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LibraryLoan_copyId_fkey" FOREIGN KEY ("copyId") REFERENCES "LibraryCopy"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "LibraryLoan_institutionId_borrowerUserId_idx" ON "LibraryLoan"("institutionId", "borrowerUserId");
CREATE INDEX IF NOT EXISTS "LibraryLoan_institutionId_returnedAt_idx" ON "LibraryLoan"("institutionId", "returnedAt");
CREATE INDEX IF NOT EXISTS "LibraryLoan_copyId_idx" ON "LibraryLoan"("copyId");

CREATE TABLE IF NOT EXISTS "LibraryFine" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "loanId" TEXT NOT NULL,
  "borrowerUserId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "collectedVia" TEXT NOT NULL,
  "paidAt" TIMESTAMP(3),
  "collectedById" TEXT,
  "waivedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LibraryFine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LibraryFine_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "LibraryLoan"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "LibraryFine_institutionId_borrowerUserId_idx" ON "LibraryFine"("institutionId", "borrowerUserId");
CREATE INDEX IF NOT EXISTS "LibraryFine_institutionId_status_idx" ON "LibraryFine"("institutionId", "status");
