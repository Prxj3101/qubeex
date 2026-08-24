-- CreateEnum
CREATE TYPE "PlanOption" AS ENUM ('NORMAL', 'COMMITTED');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "commitmentEndDate" TIMESTAMP(3),
ADD COLUMN     "planOption" "PlanOption" NOT NULL DEFAULT 'NORMAL';
