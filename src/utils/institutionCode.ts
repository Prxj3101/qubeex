import { prisma } from "./prisma";

export async function generateInstitutionCode(abbreviation: string): Promise<string> {
  const prefix = abbreviation.toUpperCase();
  const year = new Date().getFullYear();

  // Sequence is a single global counter across every institution ever
  // created on the platform (not scoped by abbreviation or year) — it
  // reflects overall creation order, e.g. the 2nd institution created
  // anywhere becomes QX-{ABBR}-{year}-0002 regardless of its abbreviation.
  const existing = await prisma.institution.count();
  const seq = String(existing + 1).padStart(4, "0");

  return `QX-${prefix}-${year}-${seq}`;
}
