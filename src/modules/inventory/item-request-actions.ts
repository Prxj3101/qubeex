// Item request fulfilment is stored in the existing request audit trail. Each
// issue and its stock movement commit together under a request row lock.
export type RequestLine = { name: string; unit: string; quantity: number };
type RequestEvent = { action: string; lineIndex?: number; quantity?: number; purchaseRequestId?: string; requestId?: string; fingerprint?: string };
const requestEvents = (value: unknown): RequestEvent[] => Array.isArray(value) ? value as RequestEvent[] : [];
export function requestProgress(lines: RequestLine[], events: unknown) {
  const history = requestEvents(events);
  return lines.map((line, index) => {
    const issued = history.filter(e => e.action === "ITEM_ISSUED" && e.lineIndex === index).reduce((sum, e) => sum + Number(e.quantity || 0), 0);
    return { ...line, issued, pending: Math.max(0, line.quantity - issued) };
  });
}
export function purchaseLink(events: unknown) {
  return requestEvents(events).find(e => e.action === "PURCHASE_REQUEST_CREATED")?.purchaseRequestId;
}
