import { prisma } from "../../utils/prisma";
import { sendDemoRequestNotificationEmail, sendDemoRequestConfirmationEmail } from "../../services/email.service";

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface CreateDemoRequestInput {
  name: string;
  email: string;
  phone: string;
  institutionName: string;
  institutionType: "SCHOOL" | "COLLEGE" | "COACHING";
  studentCount?: number;
  message?: string;
}

export const createDemoRequest = async (input: CreateDemoRequestInput) => {
  const normalizedEmail = input.email.toLowerCase();

  // Same requester re-submitting (double-click, retry) within 24h shouldn't
  // create a second lead or fire another round of emails — but it's still a
  // success from the requester's point of view, so we just return the
  // existing record instead of erroring.
  const existing = await prisma.demoRequest.findFirst({
    where: {
      email: normalizedEmail,
      createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return { demoRequest: existing, duplicate: true };

  const demoRequest = await prisma.demoRequest.create({
    data: {
      name: input.name,
      email: normalizedEmail,
      phone: input.phone,
      institutionName: input.institutionName,
      institutionType: input.institutionType,
      studentCount: input.studentCount ?? null,
      message: input.message ?? null,
    },
  });

  // The lead is already durably stored above — email delivery is best-effort
  // from here on. A failed send must never roll back or hide the request.
  const recipient = process.env.DEMO_REQUEST_EMAIL || "support@qubeex.in";
  const notifySent = await sendDemoRequestNotificationEmail({
    to: recipient,
    name: input.name,
    email: normalizedEmail,
    phone: input.phone,
    institutionName: input.institutionName,
    institutionType: input.institutionType,
    studentCount: input.studentCount,
    message: input.message,
    submittedAt: demoRequest.createdAt,
  });
  await sendDemoRequestConfirmationEmail({ to: normalizedEmail, name: input.name });

  const finalRequest = notifySent
    ? await prisma.demoRequest.update({ where: { id: demoRequest.id }, data: { emailSent: true } })
    : demoRequest;

  return { demoRequest: finalRequest, duplicate: false };
};
