-- Add Razorpay payment link fields to Bill table
ALTER TABLE "Bill" ADD COLUMN "razorpayLinkId" TEXT;
ALTER TABLE "Bill" ADD COLUMN "razorpayLinkUrl" TEXT;
ALTER TABLE "Bill" ADD COLUMN "razorpayPaymentId" TEXT;
