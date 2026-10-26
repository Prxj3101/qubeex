-- Admission form (BYOD tenant). Mirrors AdmissionSettings.admissionForm + AdmissionApplication.admissionForm.
ALTER TABLE "AdmissionSettings" ADD COLUMN IF NOT EXISTS "admissionForm" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "AdmissionApplication" ADD COLUMN IF NOT EXISTS "admissionForm" JSONB;
