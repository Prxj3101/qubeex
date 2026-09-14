-- Applied via `prisma db push` (not `migrate dev`) — same shadow-database
-- replay issue as add_push_token_table.sql.

ALTER TABLE "TaskTest"
  ADD COLUMN IF NOT EXISTS "deadlineReminderSent" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TaskAssignment"
  ADD COLUMN IF NOT EXISTS "deadlineReminderSent" BOOLEAN NOT NULL DEFAULT false;
