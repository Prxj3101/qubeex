import { Router, Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError } from "../../utils/errors";

// Read-only numbers for the inventory "View" and "Purchases" screens. Nothing here changes any data.
const router = Router();
const DAY = 24 * 60 * 60 * 1000;
const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const addDays = (date: string, days: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
const institution = (req: AuthRequest) => {
  if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account");
  return req.user.institutionId;
};

router.get("/insights", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req), db = academicDb();
    const today = istToday(), start30 = addDays(today, -29), start60 = addDays(today, -59);
    const [items, movements, recent, locations] = await Promise.all([
      db.inventoryItem.findMany({ where: { institutionId }, include: { category: { select: { name: true } }, unit: { select: { name: true, abbreviation: true } }, balances: { select: { quantity: true, locationId: true } } } }),
      db.inventoryStockMovement.findMany({
        where: { institutionId, kind: { in: ["RECEIPT", "ISSUE"] }, recordedOn: { gte: new Date(`${start60}T00:00:00Z`) } },
        select: { kind: true, itemId: true, quantity: true, totalCost: true, recordedOn: true },
      }),
      db.inventoryStockMovement.findMany({
        where: { institutionId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 8,
        include: { item: { select: { name: true, unit: { select: { name: true, abbreviation: true } } } }, location: { select: { name: true } } },
      }),
      db.inventoryLocation.findMany({ where: { institutionId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);

    // Day-by-day count of "stock added" and "stock given out" entries for the last 30 days.
    const days = Array.from({ length: 30 }, (_, i) => addDays(start30, i));
    const byDay = new Map(days.map(day => [day, { date: day, received: 0, issued: 0 }]));
    let spend30 = 0, spendPrev30 = 0;
    const issuedByItem = new Map<string, { quantity: number; times: number }>();
    for (const m of movements) {
      const day = m.recordedOn.toISOString().slice(0, 10);
      const inLast30 = day >= start30;
      if (m.kind === "RECEIPT") {
        const cost = Number(m.totalCost || 0);
        if (inLast30) spend30 += cost; else spendPrev30 += cost;
      }
      if (!inLast30) continue;
      const bucket = byDay.get(day);
      if (bucket) { if (m.kind === "RECEIPT") bucket.received += 1; else bucket.issued += 1; }
      if (m.kind === "ISSUE") {
        const current = issuedByItem.get(m.itemId) || { quantity: 0, times: 0 };
        issuedByItem.set(m.itemId, { quantity: current.quantity + Number(m.quantity), times: current.times + 1 });
      }
    }
    const itemById = new Map(items.map(item => [item.id, item]));
    const topIssued = [...issuedByItem.entries()].sort((a, b) => b[1].quantity - a[1].quantity || b[1].times - a[1].times).slice(0, 5)
      .map(([id, v]) => { const item = itemById.get(id); return { id, name: item?.name || "Item", unit: item?.unit.abbreviation || item?.unit.name || "", quantity: v.quantity, times: v.times }; });

    // Stock health of consumables: out of stock, running low, healthy.
    const total = (item: typeof items[number]) => item.balances.reduce((sum, b) => sum + Number(b.quantity), 0);
    const consumables = items.filter(item => item.type === "CONSUMABLE");
    const out = consumables.filter(item => total(item) <= 0).length;
    const low = consumables.filter(item => total(item) > 0 && Number(item.lowStockLevel) > 0 && total(item) <= Number(item.lowStockLevel)).length;
    const health = { out, low, healthy: consumables.length - out - low, total: consumables.length };

    const categoryCounts = new Map<string, number>();
    for (const item of items) categoryCounts.set(item.category.name, (categoryCounts.get(item.category.name) || 0) + 1);
    const byCategory = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));

    const byLocation = locations.map(location => ({
      id: location.id, name: location.name,
      items: items.filter(item => item.balances.some(b => b.locationId === location.id && Number(b.quantity) > 0)).length,
    })).sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));

    const activity = recent.map(m => ({
      id: m.id, kind: m.kind, itemName: m.item.name, location: m.location.name,
      quantity: Number(m.quantity), unit: m.item.unit.abbreviation || m.item.unit.name,
      issuedTo: m.issuedToName || null, supplier: m.supplierName || null,
      transferTo: m.transferLocationName || null, at: m.createdAt.toISOString(),
    }));

    res.json({ success: true, data: {
      asOf: today, trend: days.map(day => byDay.get(day)!), spend30, spendPrev30,
      topIssued, health, byCategory: byCategory.slice(0, 6), byLocation: byLocation.slice(0, 6), activity,
    } });
  } catch (err) { next(err); }
});

router.get("/purchase-stats", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institution(req), db = academicDb(), today = istToday(), weekEnd = addDays(today, 7);
    const [requests, readyToOrder, orders] = await Promise.all([
      db.inventoryPurchaseRequest.groupBy({ by: ["status"], where: { institutionId, source: { not: "TEACHER" } }, _count: { _all: true } }),
      db.inventoryPurchaseRequest.count({ where: { institutionId, source: { not: "TEACHER" }, status: "APPROVED", purchaseOrder: null } }),
      db.inventoryPurchaseOrder.findMany({ where: { institutionId }, select: { status: true, total: true, expectedOn: true } }),
    ]);
    const orderCounts: Record<string, number> = {};
    let openValue = 0, overdueDeliveries = 0, dueThisWeek = 0;
    for (const order of orders) {
      orderCounts[order.status] = (orderCounts[order.status] || 0) + 1;
      if (order.status === "APPROVED" || order.status === "PARTIALLY_RECEIVED") {
        openValue += Number(order.total);
        const expected = order.expectedOn.toISOString().slice(0, 10);
        if (expected < today) overdueDeliveries += 1; else if (expected <= weekEnd) dueThisWeek += 1;
      }
    }
    res.json({ success: true, data: {
      asOf: today,
      requests: Object.fromEntries(requests.map(row => [row.status, row._count._all])),
      readyToOrder, orders: orderCounts, openValue, overdueDeliveries, dueThisWeek,
    } });
  } catch (err) { next(err); }
});

export default router;
