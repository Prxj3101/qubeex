-- Teacher status enum
DO $$ BEGIN
  CREATE TYPE "TeacherStatus" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Teacher
CREATE TABLE IF NOT EXISTS "Teacher" (
  "id" TEXT NOT NULL,
  "teacherId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "phone" TEXT,
  "avatarUrl" TEXT,
  "dob" TEXT,
  "gender" TEXT,
  "address" TEXT,
  "city" TEXT,
  "state" TEXT,
  "pincode" TEXT,
  "country" TEXT DEFAULT 'India',
  "qualification" TEXT,
  "experience" TEXT,
  "status" "TeacherStatus" NOT NULL DEFAULT 'ACTIVE',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Teacher_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Teacher_userId_key" ON "Teacher"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "Teacher_teacherId_institutionId_key" ON "Teacher"("teacherId", "institutionId");
CREATE INDEX IF NOT EXISTS "Teacher_institutionId_idx" ON "Teacher"("institutionId");

DO $$ BEGIN
  ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Bill payment status enum (shared with Subscription)
DO $$ BEGIN
  CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'PENDING', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Bill
CREATE TABLE IF NOT EXISTS "Bill" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "billingMonth" TEXT,
  "userCount" INTEGER NOT NULL DEFAULT 0,
  "baseAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "addonAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalAmount" DOUBLE PRECISION NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "items" JSONB NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueDate" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "Bill" ADD CONSTRAINT "Bill_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Notification
CREATE TABLE IF NOT EXISTS "Notification" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "recipientType" TEXT NOT NULL,
  "deliveredTo" INTEGER NOT NULL DEFAULT 0,
  "sentById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- NotificationRecipient
CREATE TABLE IF NOT EXISTS "NotificationRecipient" (
  "id" TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  CONSTRAINT "NotificationRecipient_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- SupportTicket
CREATE TABLE IF NOT EXISTS "SupportTicket" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "priority" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "institutionId" TEXT NOT NULL,
  "adminEmail" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- TicketReply
CREATE TABLE IF NOT EXISTS "TicketReply" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketReply_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "TicketReply" ADD CONSTRAINT "TicketReply_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Review
CREATE TABLE IF NOT EXISTS "Review" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "adminName" TEXT NOT NULL,
  "adminEmail" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "likes" INTEGER NOT NULL DEFAULT 0,
  "replyMessage" TEXT,
  "repliedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "Review" ADD CONSTRAINT "Review_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
