import { Router, Response, NextFunction } from "express";
import crypto from "crypto";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError } from "../../utils/errors";
import { redis } from "../../utils/redis";
import { recordAiUsage, getInstitutionAiTokenLimit, getInstitutionPoolUsed } from "../../services/ai-usage.service";

// Read-only numbers for the new inventory "View" page: what needs doing today, what will run out,
// where stock sits, who is holding items, and anything that looks odd. All maths is done here with
// plain rules. The AI brief (POST /overview/ai-brief) only words these findings, it never calculates.
const router = Router();
const DAY = 24 * 60 * 60 * 1000;
const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const addDays = (date: string, days: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY);
const institution = (req: AuthRequest) => {
  if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account");
  return req.user.institutionId;
};
const round1 = (value: number) => Math.round(value * 10) / 10;
const ymd = (value: Date) => value.toISOString().slice(0, 10);

type Tone = "rose" | "amber" | "blue" | "violet" | "emerald";
type ActionKey = "REQUESTS" | "ISSUE_APPROVED" | "PURCHASE_APPROVAL" | "READY_TO_ORDER" | "DELIVERIES" | "OVERDUE_RETURNS" | "LOW_STOCK";

async function computeOverview(institutionId: string) {
  const db = academicDb();
  const today = istToday(), start7 = addDays(today, -6), start28 = addDays(today, -27), start30 = addDays(today, -29), start90 = addDays(today, -89);
  const [items, locations, moves, openIssues, teacherRequests, pendingPurchase, readyToOrder, openOrders, lastReceipts] = await Promise.all([
    db.inventoryItem.findMany({ where: { institutionId }, select: { id: true, name: true, type: true, lowStockLevel: true, unit: { select: { name: true, abbreviation: true } }, balances: { select: { quantity: true, locationId: true } } } }),
    db.inventoryLocation.findMany({ where: { institutionId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.inventoryStockMovement.findMany({ where: { institutionId, recordedOn: { gte: new Date(`${start90}T00:00:00Z`) } }, select: { kind: true, itemId: true, quantity: true, recordedOn: true } }),
    db.inventoryStockMovement.findMany({ where: { institutionId, kind: "ISSUE", returnExpected: true }, select: { id: true, itemId: true, quantity: true, dueOn: true, issuedToName: true, issuedToLabel: true, item: { select: { name: true } }, returns: { select: { kind: true, quantity: true } } } }),
    db.inventoryPurchaseRequest.findMany({ where: { institutionId, source: "TEACHER", status: { in: ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] } }, select: { status: true, createdAt: true } }),
    db.inventoryPurchaseRequest.count({ where: { institutionId, source: { not: "TEACHER" }, status: "PENDING" } }),
    db.inventoryPurchaseRequest.count({ where: { institutionId, source: { not: "TEACHER" }, status: "APPROVED", purchaseOrder: null } }),
    db.inventoryPurchaseOrder.findMany({ where: { institutionId, status: { in: ["APPROVED", "PARTIALLY_RECEIVED"] } }, select: { expectedOn: true } }),
    db.inventoryStockMovement.findMany({ where: { institutionId, kind: "RECEIPT", totalCost: { not: null } }, orderBy: [{ createdAt: "desc" }], distinct: ["itemId"], select: { itemId: true, quantity: true, totalCost: true } }),
  ]);

  const unitOf = (item: typeof items[number]) => item.unit.abbreviation || item.unit.name;
  const stockOf = (item: typeof items[number]) => item.balances.reduce((sum, b) => sum + Number(b.quantity), 0);
  const itemById = new Map(items.map(item => [item.id, item]));

  // Open returns: an issue is still out when the quantity given is more than what came back, damaged or lost.
  const holdersMap = new Map<string, { name: string; entries: number; overdue: number; nextDue: string | null; itemNames: string[] }>();
  let overdueReturns = 0, longOverdue = 0, pendingReturns = 0;
  for (const issue of openIssues) {
    const back = issue.returns.filter(r => ["RETURN", "ISSUE_DAMAGED", "ISSUE_LOST"].includes(r.kind)).reduce((sum, r) => sum + Number(r.quantity), 0);
    if (Number(issue.quantity) <= back) continue;
    pendingReturns += 1;
    const due = issue.dueOn ? ymd(issue.dueOn) : null;
    const late = due !== null && due < today;
    if (late) { overdueReturns += 1; if (daysBetween(due!, today) > 14) longOverdue += 1; }
    const name = issue.issuedToName || issue.issuedToLabel || "Not named";
    const holder = holdersMap.get(name) || { name, entries: 0, overdue: 0, nextDue: null, itemNames: [] };
    holder.entries += 1; if (late) holder.overdue += 1;
    if (due && (!holder.nextDue || due < holder.nextDue)) holder.nextDue = due;
    if (!holder.itemNames.includes(issue.item.name)) holder.itemNames.push(issue.item.name);
    holdersMap.set(name, holder);
  }
  const holdersAll = [...holdersMap.values()].sort((a, b) => b.overdue - a.overdue || b.entries - a.entries || a.name.localeCompare(b.name));
  const holders = holdersAll.slice(0, 6).map(h => ({ name: h.name, entries: h.entries, overdue: h.overdue, nextDue: h.nextDue, itemNames: h.itemNames.slice(0, 2), moreItems: Math.max(0, h.itemNames.length - 2) }));

  // Stock health of consumables.
  const consumables = items.filter(item => item.type === "CONSUMABLE");
  const outCount = consumables.filter(item => stockOf(item) <= 0).length;
  const lowCount = consumables.filter(item => stockOf(item) > 0 && Number(item.lowStockLevel) > 0 && stockOf(item) <= Number(item.lowStockLevel)).length;

  // Usage in the last 30 days, per item.
  const issued30 = new Map<string, number>(), issued7 = new Map<string, number>(), issuedMid = new Map<string, number>();
  const lossByItem = new Map<string, { count: number; lost: number }>(), adjustByItem = new Map<string, number>();
  const heat = new Map<string, number>();
  for (const m of moves) {
    const day = ymd(m.recordedOn), qty = Number(m.quantity);
    heat.set(day, (heat.get(day) || 0) + 1);
    if (day >= start30) {
      if (m.kind === "ISSUE") issued30.set(m.itemId, (issued30.get(m.itemId) || 0) + qty);
      if (m.kind === "ISSUE_DAMAGED" || m.kind === "ISSUE_LOST") { const cur = lossByItem.get(m.itemId) || { count: 0, lost: 0 }; cur.count += 1; if (m.kind === "ISSUE_LOST") cur.lost += 1; lossByItem.set(m.itemId, cur); }
      if (m.kind === "ADJUSTMENT") adjustByItem.set(m.itemId, (adjustByItem.get(m.itemId) || 0) + 1);
    }
    if (m.kind === "ISSUE") {
      if (day >= start7) issued7.set(m.itemId, (issued7.get(m.itemId) || 0) + qty);
      else if (day >= start28) issuedMid.set(m.itemId, (issuedMid.get(m.itemId) || 0) + qty);
    }
  }

  // "How many days will it last": stock divided by the daily use of the last 30 days.
  const runwayAll = consumables.map(item => {
    const stock = stockOf(item), used = issued30.get(item.id) || 0, daily = used / 30, low = Number(item.lowStockLevel);
    const daysLeft = daily > 0 ? stock / daily : null;
    const belowLimit = low > 0 && stock <= low;
    const suggested = daily > 0 ? Math.max(1, Math.ceil(daily * 30 - stock)) : Math.max(1, Math.ceil(low * 2 - stock));
    return { id: item.id, name: item.name, unit: unitOf(item), unitName: item.unit.name, stock, daily: round1(daily), daysLeft: daysLeft === null ? null : Math.max(0, Math.round(daysLeft)), belowLimit, suggested };
  }).filter(r => (r.daysLeft !== null && r.daysLeft <= 21) || r.belowLimit || r.stock <= 0)
    .sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999) || a.name.localeCompare(b.name));
  const runway = runwayAll.slice(0, 6).map(r => ({ ...r, urgency: r.stock <= 0 || (r.daysLeft !== null && r.daysLeft <= 7) ? "critical" as const : "soon" as const }));

  // What needs doing today.
  const pendingTeacher = teacherRequests.filter(r => r.status === "PENDING");
  const toIssue = teacherRequests.filter(r => r.status !== "PENDING");
  const oldestPending = pendingTeacher.length ? Math.max(...pendingTeacher.map(r => daysBetween(ymd(r.createdAt), today))) : 0;
  const lateDeliveries = openOrders.filter(o => ymd(o.expectedOn) < today).length;
  const dueSoon = openOrders.filter(o => { const d = ymd(o.expectedOn); return d >= today && d <= addDays(today, 7); }).length;
  const actions: { key: ActionKey; tone: Tone; count: number; title: string; detail: string; button: string }[] = [];
  if (pendingTeacher.length) actions.push({ key: "REQUESTS", tone: "blue", count: pendingTeacher.length, title: `${pendingTeacher.length} teacher request${pendingTeacher.length === 1 ? "" : "s"} waiting for approval`, detail: oldestPending > 0 ? `Oldest is ${oldestPending} day${oldestPending === 1 ? "" : "s"} old` : "Sent today", button: "Review" });
  if (toIssue.length) actions.push({ key: "ISSUE_APPROVED", tone: "emerald", count: toIssue.length, title: `${toIssue.length} approved request${toIssue.length === 1 ? "" : "s"} to give out`, detail: "Teachers are waiting for these items", button: "Give out" });
  if (overdueReturns) actions.push({ key: "OVERDUE_RETURNS", tone: "rose", count: overdueReturns, title: `${overdueReturns} return${overdueReturns === 1 ? " is" : "s are"} overdue`, detail: longOverdue ? `${longOverdue} more than 2 weeks late` : "Follow up with the holders", button: "See returns" });
  if (outCount + lowCount) actions.push({ key: "LOW_STOCK", tone: "amber", count: outCount + lowCount, title: `${outCount + lowCount} item${outCount + lowCount === 1 ? "" : "s"} out or running low`, detail: outCount ? `${outCount} out of stock` : "Reorder before they finish", button: "See items" });
  if (pendingPurchase) actions.push({ key: "PURCHASE_APPROVAL", tone: "violet", count: pendingPurchase, title: `${pendingPurchase} purchase request${pendingPurchase === 1 ? "" : "s"} to approve`, detail: "Approve so an order can be placed", button: "Review" });
  if (readyToOrder) actions.push({ key: "READY_TO_ORDER", tone: "violet", count: readyToOrder, title: `${readyToOrder} approved request${readyToOrder === 1 ? "" : "s"} ready to order`, detail: "Choose a supplier and place the order", button: "Place order" });
  if (lateDeliveries || dueSoon) actions.push({ key: "DELIVERIES", tone: lateDeliveries ? "rose" : "blue", count: lateDeliveries + dueSoon, title: lateDeliveries ? `${lateDeliveries} order${lateDeliveries === 1 ? " is" : "s are"} late` : `${dueSoon} deliver${dueSoon === 1 ? "y" : "ies"} due this week`, detail: lateDeliveries && dueSoon ? `${dueSoon} more due this week` : "Check with the supplier", button: "Track" });

  // Health score out of 100 and what pulled it down.
  const factors: { label: string; points: number }[] = [];
  const total = Math.max(1, consumables.length);
  if (outCount) factors.push({ label: `${outCount} out of stock`, points: Math.round((outCount / total) * 40) });
  if (lowCount) factors.push({ label: `${lowCount} running low`, points: Math.round((lowCount / total) * 20) });
  if (overdueReturns) factors.push({ label: `${overdueReturns} overdue return${overdueReturns === 1 ? "" : "s"}`, points: Math.min(20, overdueReturns * 5) });
  if (lateDeliveries) factors.push({ label: `${lateDeliveries} late order${lateDeliveries === 1 ? "" : "s"}`, points: Math.min(10, lateDeliveries * 5) });
  const staleRequests = pendingTeacher.filter(r => daysBetween(ymd(r.createdAt), today) >= 3).length;
  if (staleRequests) factors.push({ label: `${staleRequests} request${staleRequests === 1 ? "" : "s"} waiting 3+ days`, points: Math.min(10, staleRequests * 2) });
  const score = Math.max(0, 100 - factors.reduce((sum, f) => sum + f.points, 0));
  const visibleFactors = factors.filter(f => f.points > 0).sort((a, b) => b.points - a.points);

  // Stock value at the latest purchase price of each item.
  const costByItem = new Map(lastReceipts.map(r => [r.itemId, Number(r.quantity) > 0 ? Number(r.totalCost) / Number(r.quantity) : 0]));
  let stockValue = 0, valuedItems = 0;
  for (const item of items) { const unitCost = costByItem.get(item.id); if (unitCost && unitCost > 0) { stockValue += stockOf(item) * unitCost; valuedItems += 1; } }

  // Where the stock sits.
  const lowIds = new Set(consumables.filter(i => stockOf(i) <= 0 || (Number(i.lowStockLevel) > 0 && stockOf(i) <= Number(i.lowStockLevel))).map(i => i.id));
  const locationCards = locations.map(location => {
    const here = items.filter(item => item.balances.some(b => b.locationId === location.id && Number(b.quantity) > 0));
    return { id: location.id, name: location.name, items: here.length, low: here.filter(i => lowIds.has(i.id)).length, topItems: here.slice(0, 2).map(i => i.name) };
  }).sort((a, b) => b.items - a.items || a.name.localeCompare(b.name)).slice(0, 12);

  // 90 day calendar of how busy each day was.
  const heatmap = Array.from({ length: 90 }, (_, i) => { const date = addDays(start90, i); return { date, count: heat.get(date) || 0 }; });

  // Things that look odd.
  const anomalies: { id: string; level: "critical" | "warning"; title: string; detail: string }[] = [];
  for (const [itemId, v] of lossByItem) {
    const item = itemById.get(itemId); if (!item || (v.count < 2 && !v.lost)) continue;
    anomalies.push({ id: `LOSS:${itemId}`, level: v.lost ? "critical" : "warning", title: `${item.name}: ${v.count} marked damaged or lost`, detail: "In the last 30 days" });
  }
  for (const [itemId, week] of issued7) {
    const item = itemById.get(itemId); if (!item) continue;
    const usual = (issuedMid.get(itemId) || 0) / 3;
    if (usual > 0 && week >= 3 && week > usual * 2.5 && week - usual >= 3) anomalies.push({ id: `SPIKE:${itemId}`, level: "warning", title: `${item.name}: ${Math.round(week)} ${unitOf(item)} given out this week`, detail: `Usually about ${Math.round(usual)} ${unitOf(item)} a week` });
  }
  for (const [itemId, count] of adjustByItem) {
    const item = itemById.get(itemId); if (!item || count < 3) continue;
    anomalies.push({ id: `ADJUST:${itemId}`, level: "warning", title: `${item.name}: stock count corrected ${count} times`, detail: "In the last 30 days" });
  }
  if (longOverdue) anomalies.push({ id: "LATE", level: "critical", title: `${longOverdue} return${longOverdue === 1 ? " is" : "s are"} more than 2 weeks late`, detail: "Items may be lost or forgotten" });
  anomalies.sort((a, b) => (a.level === b.level ? 0 : a.level === "critical" ? -1 : 1));

  return {
    asOf: today, score, scoreFactors: visibleFactors.slice(0, 3), stockValue: Math.round(stockValue), valuedItems, totalItems: items.length,
    actions, runway, runwayTotal: runwayAll.length, locations: locationCards, holders, holdersTotal: holdersAll.length, pendingReturns,
    heatmap, anomalies: anomalies.slice(0, 5), anomalyTotal: anomalies.length,
  };
}
type Overview = Awaited<ReturnType<typeof computeOverview>>;

router.get("/overview", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await computeOverview(institution(req)) }); } catch (err) { next(err); }
});

// ── AI brief ────────────────────────────────────────────────────────────────
// Same OpenAI/Groq bootstrap + token-pool + usage tracking as payrollAiReview.service.ts.
// Only the written brief uses AI; reorder and alert lines come straight from the rules above.
// Only item names and counts are sent (no people, no prices). One small call, cached per day
// and only repeated when the numbers change, so it costs a few hundred tokens at most.
const OpenAIModule = (process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY) ? require("openai") : null;
const openai: import("openai").OpenAI | null = OpenAIModule
  ? new OpenAIModule.OpenAI(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : { apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" })
  : null;
const AI_MODEL = process.env.OPENAI_API_KEY ? "gpt-4.1-mini" : "openai/gpt-oss-120b";
const AI_PROVIDER: "openai" | "groq" = process.env.OPENAI_API_KEY ? "openai" : "groq";

type Brief = { brief: string; aiGenerated: boolean; generatedAt: string; hash: string };
const memoryCache = new Map<string, { value: Brief; expires: number }>();
async function readCache(key: string): Promise<Brief | null> {
  try { if (redis) { const raw = await redis.get(key); if (raw) return JSON.parse(raw) as Brief; } } catch { /* fall back to memory */ }
  const hit = memoryCache.get(key); return hit && hit.expires > Date.now() ? hit.value : null;
}
async function writeCache(key: string, value: Brief) {
  memoryCache.set(key, { value, expires: Date.now() + DAY });
  try { if (redis) await redis.set(key, JSON.stringify(value), "EX", 24 * 60 * 60); } catch { /* memory copy is enough */ }
}

function plainBrief(o: Overview) {
  if (!o.actions.length && !o.anomalies.length && !o.runway.length) return "Everything is in good shape today. Nothing needs your attention.";
  const parts: string[] = [];
  if (o.actions.length) parts.push(`${o.actions.length} thing${o.actions.length === 1 ? "" : "s"} need${o.actions.length === 1 ? "s" : ""} you today, starting with: ${o.actions[0].title.toLowerCase()}.`);
  if (o.runway.length) parts.push(`${o.runway[0].name} ${o.runway[0].stock <= 0 ? "is out of stock" : o.runway[0].daysLeft !== null ? `will last about ${o.runway[0].daysLeft} more day${o.runway[0].daysLeft === 1 ? "" : "s"}` : "is running low"}.`);
  return parts.join(" ");
}

router.post("/overview/ai-brief", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req), refresh = req.body?.refresh === true;
    const o = await computeOverview(institutionId);
    const hash = crypto.createHash("sha1").update(JSON.stringify({ a: o.actions.map(x => [x.key, x.count]), r: o.runway.map(x => [x.id, x.daysLeft]), n: o.anomalies.map(x => x.id), s: o.score })).digest("hex").slice(0, 16);
    const fallback: Brief = { brief: plainBrief(o), aiGenerated: false, generatedAt: new Date().toISOString(), hash };
    const key = `inv:ai-brief:${institutionId}:${o.asOf}`;
    const cached = await readCache(key);
    if (cached && cached.hash === hash && !refresh) { res.json({ success: true, data: cached }); return; }
    if (!openai || (!o.actions.length && !o.runway.length && !o.anomalies.length)) { res.json({ success: true, data: fallback }); return; }
    // Out of tokens or a failed call must never break the page: show the plain version instead.
    const [used, limit] = await Promise.all([getInstitutionPoolUsed(institutionId).catch(() => 0), getInstitutionAiTokenLimit(institutionId).catch(() => 0)]);
    if (limit > 0 && used >= limit) { res.json({ success: true, data: cached || fallback }); return; }

    const payload = {
      score: o.score,
      todo: o.actions.slice(0, 5).map(a => a.title),
      running_out: o.runway.slice(0, 4).map(r => ({ item: r.name, stock: `${r.stock} ${r.unit}`, days_left: r.daysLeft })),
      odd: o.anomalies.slice(0, 3).map(a => `${a.title}. ${a.detail}`),
    };
    const system = "You write the daily inventory brief for a school admin. Use ONLY the facts given, never calculate or invent numbers. " +
      "Reply JSON {\"brief\":\"at most 2 short sentences, max 40 words, simple English, mention the most important thing first\"}. No em dash.";
    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }],
        response_format: { type: "json_object" },
        max_tokens: 500,
        ...(AI_PROVIDER === "groq" ? { reasoning_effort: "low" as const } : {}),
      });
    } catch (err) {
      console.error("[inventory-ai] brief failed:", err instanceof Error ? err.message : err);
      await recordAiUsage({ institutionId, userId: req.user!.userId, userRole: req.user!.role, feature: "INVENTORY_BRIEF", provider: AI_PROVIDER, model: AI_MODEL, requestType: "chat_completion", status: "FAILED", error: err instanceof Error ? err.message : String(err) });
      res.json({ success: true, data: cached || fallback }); return;
    }
    await recordAiUsage({ institutionId, userId: req.user!.userId, userRole: req.user!.role, feature: "INVENTORY_BRIEF", provider: AI_PROVIDER, model: AI_MODEL, requestType: "chat_completion", status: "SUCCESS", inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens, totalTokens: completion.usage?.total_tokens });

    let parsed: { brief?: unknown } = {};
    try { parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}"); } catch { parsed = {}; }
    const clean = (value: unknown, max: number) => typeof value === "string" ? value.replace(/—/g, " - ").trim().slice(0, max) : "";
    const brief = clean(parsed.brief, 320);
    const value: Brief = { brief: brief || fallback.brief, aiGenerated: !!brief, generatedAt: new Date().toISOString(), hash };
    await writeCache(key, value);
    res.json({ success: true, data: value });
  } catch (err) { next(err); }
});

export default router;
