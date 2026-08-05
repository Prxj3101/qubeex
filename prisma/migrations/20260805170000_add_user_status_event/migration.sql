-- Records every isActive transition for a user (creation, activation,
-- deactivation, invite accepted) with a timestamp, so monthly active/inactive
-- history can be reconstructed accurately going forward.

CREATE TABLE "UserStatusEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "institutionId" TEXT,
    "isActive" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserStatusEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserStatusEvent_userId_createdAt_idx" ON "UserStatusEvent"("userId", "createdAt");

CREATE INDEX "UserStatusEvent_institutionId_idx" ON "UserStatusEvent"("institutionId");

ALTER TABLE "UserStatusEvent" ADD CONSTRAINT "UserStatusEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Bootstrap one event per existing user reflecting their current isActive
-- value, so every user has at least one history row from today onward.
-- Historical months before this point remain best-effort/approximate — this
-- is expected since the project isn't live yet and precise pre-migration
-- history isn't required.
-- Avoids depending on pgcrypto/uuid-ossp extensions being enabled — the id
-- column is plain text (Prisma generates uuids client-side), so any unique
-- string works here.
INSERT INTO "UserStatusEvent" ("id", "userId", "institutionId", "isActive", "createdAt")
SELECT md5(random()::text || clock_timestamp()::text || "id"), "id", "institutionId", "isActive", CURRENT_TIMESTAMP
FROM "User";
