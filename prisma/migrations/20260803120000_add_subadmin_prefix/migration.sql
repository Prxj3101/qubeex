-- Add prefix (Mr./Ms./Mrs./Dr. etc.) to SubAdmin, matching Admin's prefix field
ALTER TABLE "SubAdmin" ADD COLUMN "prefix" TEXT;
