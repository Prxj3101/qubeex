-- Parent form reminders: track the automatic reminder and throttle the manual one.
ALTER TABLE "ParentForm" ADD COLUMN "reminderSentAt" TIMESTAMP(3);
ALTER TABLE "ParentForm" ADD COLUMN "lastRemindedAt" TIMESTAMP(3);
