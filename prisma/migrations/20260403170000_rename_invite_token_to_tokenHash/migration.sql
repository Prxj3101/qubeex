-- Delete all existing invites (plaintext tokens are no longer compatible)
DELETE FROM "Invite";

-- Drop the old unique index on "token"
DROP INDEX IF EXISTS "Invite_token_key";

-- Rename column: token → tokenHash
ALTER TABLE "Invite" RENAME COLUMN "token" TO "tokenHash";

-- Create new unique index on "tokenHash"
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");
