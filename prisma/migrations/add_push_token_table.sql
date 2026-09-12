-- Applied via `prisma db push` (not `migrate dev`) because migrate dev's
-- shadow-database replay is currently broken on an unrelated older migration
-- (20260911140000_unify_staff_payroll references a since-renamed Teacher
-- column). Recorded here for history, matching add_subadmin_avatar_field.sql.

CREATE TABLE IF NOT EXISTS "PushToken" (
  "id"        TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"    TEXT NOT NULL,
  "token"     TEXT NOT NULL UNIQUE,
  "platform"  TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id")
);

CREATE INDEX IF NOT EXISTS "PushToken_userId_idx" ON "PushToken"("userId");
