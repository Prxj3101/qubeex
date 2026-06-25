import { Request, Response } from "express";
import crypto from "crypto";
import { markBillPaid } from "../../services/billing.service";

const verifySignature = (rawBody: Buffer, signature: string): boolean => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET!;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
};

export const razorpayWebhookHandler = async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers["x-razorpay-signature"] as string | undefined;

  if (!signature) {
    res.status(400).json({ error: "Missing signature" });
    return;
  }

  const rawBody = req.body as Buffer;

  if (!verifySignature(rawBody, signature)) {
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const event = payload.event as string;

  if (event === "payment_link.paid") {
    try {
      const plEntity = (payload.payload as Record<string, unknown>)?.payment_link as
        | Record<string, unknown>
        | undefined;
      const payEntity = (payload.payload as Record<string, unknown>)?.payment as
        | Record<string, unknown>
        | undefined;

      const billId = (plEntity?.entity as Record<string, unknown>)?.reference_id as string;
      const razorpayPaymentId = (payEntity?.entity as Record<string, unknown>)?.id as string;

      if (!billId) {
        console.warn("[Webhook] payment_link.paid missing reference_id");
        res.json({ received: true });
        return;
      }

      await markBillPaid(billId, razorpayPaymentId);
      console.log(`[Webhook] Bill ${billId} marked paid via Razorpay ${razorpayPaymentId}`);
    } catch (err) {
      console.error("[Webhook] markBillPaid failed:", err);
      // Return 200 so Razorpay doesn't retry for non-transient errors
    }
  }

  res.json({ received: true });
};
