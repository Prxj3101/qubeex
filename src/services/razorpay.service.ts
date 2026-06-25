import Razorpay from "razorpay";
import { prisma } from "../utils/prisma";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export const ensurePaymentLink = async (
  billId: string
): Promise<{ linkId: string; linkUrl: string }> => {
  const bill = await prisma.bill.findUnique({
    where: { id: billId },
    select: {
      razorpayLinkId: true,
      razorpayLinkUrl: true,
      totalAmount: true,
      billingMonth: true,
    },
  });

  if (!bill) throw new Error(`Bill ${billId} not found`);

  if (bill.razorpayLinkId && bill.razorpayLinkUrl) {
    return { linkId: bill.razorpayLinkId, linkUrl: bill.razorpayLinkUrl };
  }

  const expireBy = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  const amountInPaise = Math.round(Number(bill.totalAmount) * 100);
  console.log(`[Razorpay] Bill ${billId}: totalAmount=₹${bill.totalAmount} → ${amountInPaise} paise`);

  if (!Number.isFinite(amountInPaise) || amountInPaise < 100) {
    throw new Error(
      `Bill ${billId} has invalid amount: ₹${bill.totalAmount} (min ₹1 required)`
    );
  }
  // Razorpay payment link default maximum is ₹5,00,000 (5 lakh)
  if (amountInPaise > 50_000_000) {
    throw new Error(
      `Bill ${billId} amount ₹${Number(bill.totalAmount).toLocaleString("en-IN")} exceeds Razorpay payment link limit of ₹5,00,000. Contact Razorpay support to raise the limit.`
    );
  }

  // Razorpay SDK v2.x has incorrect TypeScript types: paymentLink.create is
  // typed as returning void and requires fields (customer/options) that the
  // REST API does not actually require. Cast to work around both issues.
  const createLink = razorpay.paymentLink.create as unknown as (
    body: Record<string, unknown>
  ) => Promise<{ id: string; short_url: string }>;

  let link: { id: string; short_url: string };
  try {
    link = await createLink({
      amount: amountInPaise,
      currency: "INR",
      description: `QubeEx Bill${bill.billingMonth ? ` - ${bill.billingMonth}` : ""}`,
      reference_id: billId,
      expire_by: expireBy,
      notify: { sms: false, email: false },
      reminder_enable: false,
    });
  } catch (err: unknown) {
    const rzpErr = err as { statusCode?: number; error?: { description?: string } };
    const desc = rzpErr?.error?.description ?? String(err);
    if (rzpErr?.statusCode === 400 && desc.toLowerCase().includes("amount")) {
      throw new Error(
        `Razorpay rejected the bill amount ₹${Number(bill.totalAmount).toLocaleString("en-IN")}. ` +
          `Your Razorpay account may have a lower payment link limit — check Settings → Payment Links in the Razorpay dashboard, or contact Razorpay support to raise it.`
      );
    }
    throw err;
  }

  const linkId = link.id;
  const linkUrl = link.short_url;
  if (!linkUrl) throw new Error(`Razorpay did not return short_url for link ${linkId}`);

  await prisma.bill.update({
    where: { id: billId },
    data: { razorpayLinkId: linkId, razorpayLinkUrl: linkUrl },
  });

  return { linkId, linkUrl };
};

export const cancelPaymentLink = async (linkId: string): Promise<void> => {
  try {
    await razorpay.paymentLink.cancel(linkId);
  } catch (err: unknown) {
    // If already cancelled or paid, Razorpay returns 400 — treat as no-op
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Razorpay] cancelPaymentLink(${linkId}) ignored: ${msg}`);
  }
};
