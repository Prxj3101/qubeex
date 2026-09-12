import type { Expo as ExpoType, ExpoPushMessage } from "expo-server-sdk";
import { prisma } from "../utils/prisma";

// expo-server-sdk ships ESM-only ("type": "module", no CJS build). A static
// top-level `import` compiles to a synchronous `require()` under this
// project's CommonJS output, which throws ERR_REQUIRE_ESM at module-load time
// — breaking every test that transitively imports app.ts, since Jest doesn't
// tolerate it (unlike ts-node-dev, which happens to). A dynamic `import()`
// works from CJS regardless, and defers loading until a push is actually sent.
let expoModule: Promise<typeof import("expo-server-sdk")> | null = null;
function loadExpo() {
  if (!expoModule) expoModule = import("expo-server-sdk");
  return expoModule;
}

let expoClient: ExpoType | null = null;
async function getExpoClient(): Promise<ExpoType> {
  const { Expo } = await loadExpo();
  if (!expoClient) expoClient = new Expo();
  return expoClient;
}

export async function registerPushToken(userId: string, token: string, platform: string): Promise<void> {
  const { Expo } = await loadExpo();
  if (!Expo.isExpoPushToken(token)) return;
  await prisma.pushToken.upsert({
    where: { token },
    update: { userId, platform },
    create: { userId, token, platform },
  });
}

export async function unregisterPushToken(token: string): Promise<void> {
  await prisma.pushToken.deleteMany({ where: { token } });
}

type PushRecipient = { userId: string | null; institutionId: string };

/**
 * Fires an Expo push for every device registered to the notification's
 * recipients. A recipient with userId=null is a broadcast-to-institution row
 * (see notifications.controller.ts's listNotifications OR clause) — pushed to
 * every active user in that institution, not just one person.
 */
export async function dispatchPush(
  notification: { id: string; title: string; message: string; tag: string },
  recipients: PushRecipient[]
): Promise<void> {
  if (recipients.length === 0) return;

  const explicitUserIds = recipients.filter((r) => r.userId).map((r) => r.userId as string);
  const broadcastInstitutionIds = [...new Set(recipients.filter((r) => !r.userId).map((r) => r.institutionId))];

  let broadcastUserIds: string[] = [];
  if (broadcastInstitutionIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { institutionId: { in: broadcastInstitutionIds }, isActive: true },
      select: { id: true },
    });
    broadcastUserIds = users.map((u) => u.id);
  }

  const targetUserIds = [...new Set([...explicitUserIds, ...broadcastUserIds])];
  if (targetUserIds.length === 0) return;

  const tokens = await prisma.pushToken.findMany({ where: { userId: { in: targetUserIds } } });

  const { Expo } = await loadExpo();
  const validTokens = tokens.filter((t) => Expo.isExpoPushToken(t.token));
  if (validTokens.length === 0) return;

  const messages: ExpoPushMessage[] = validTokens.map((t) => ({
    to: t.token,
    title: notification.title,
    body: notification.message,
    data: { notificationId: notification.id, tag: notification.tag },
    sound: "default",
  }));

  const expo = await getExpoClient();
  const chunks = expo.chunkPushNotifications(messages);
  const invalidTokens: string[] = [];

  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      receipts.forEach((receipt, i) => {
        if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
          invalidTokens.push(chunk[i].to as string);
        }
      });
    } catch (err) {
      console.error("[Push] chunk send failed:", (err as Error).message);
    }
  }

  if (invalidTokens.length > 0) {
    await prisma.pushToken.deleteMany({ where: { token: { in: invalidTokens } } });
  }
}
