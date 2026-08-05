-- Convert StudentRemark's single attachment (attachmentUrl/attachmentType/attachmentName)
-- into a JSON array `attachments` of {url, name, type}, so a report can carry
-- multiple attachments. Existing single attachments are carried over as a
-- one-item array — no data loss.

ALTER TABLE "StudentRemark" ADD COLUMN "attachments" JSONB;

UPDATE "StudentRemark"
SET "attachments" = CASE
    WHEN "attachmentUrl" IS NOT NULL THEN
        jsonb_build_array(jsonb_build_object('url', "attachmentUrl", 'name', "attachmentName", 'type', "attachmentType"))
    ELSE '[]'::jsonb
END;

ALTER TABLE "StudentRemark" ALTER COLUMN "attachments" SET DEFAULT '[]'::jsonb;
ALTER TABLE "StudentRemark" ALTER COLUMN "attachments" SET NOT NULL;

ALTER TABLE "StudentRemark" DROP COLUMN "attachmentUrl";
ALTER TABLE "StudentRemark" DROP COLUMN "attachmentType";
ALTER TABLE "StudentRemark" DROP COLUMN "attachmentName";
