ALTER TABLE "SubAdmin"
  ADD COLUMN IF NOT EXISTS "designation"   TEXT,
  ADD COLUMN IF NOT EXISTS "phone"         TEXT,
  ADD COLUMN IF NOT EXISTS "dob"           TEXT,
  ADD COLUMN IF NOT EXISTS "gender"        TEXT,
  ADD COLUMN IF NOT EXISTS "address"       TEXT,
  ADD COLUMN IF NOT EXISTS "city"          TEXT,
  ADD COLUMN IF NOT EXISTS "state"         TEXT,
  ADD COLUMN IF NOT EXISTS "pincode"       TEXT,
  ADD COLUMN IF NOT EXISTS "country"       TEXT DEFAULT 'India',
  ADD COLUMN IF NOT EXISTS "qualification" TEXT,
  ADD COLUMN IF NOT EXISTS "experience"    TEXT;
