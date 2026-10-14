import { academicDb } from "../../utils/academicContext";
export type SetupKind = "categories" | "units" | "locations" | "suppliers";
export async function withSetupOrder<T extends { id: string }>(kind: SetupKind, institutionId: string, rows: T[]) {
  const saved = await academicDb().inventorySetupOrder.findUnique({ where: { institutionId_kind: { institutionId, kind } } });
  const ids = (saved?.ids || []) as string[];
  const positions = new Map(ids.map((id, index) => [id, index]));
  // Existing records follow the saved order; newly added records follow them.
  const data = [...rows].sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  return { data, orderRevision: saved?.revision || 0 };
}
