import { prisma } from "./prisma";

export async function generateInstitutionCode(
  abbreviation: string,
  type: string
): Promise<string> {
  const prefix = abbreviation.toUpperCase();
  const year = new Date().getFullYear();

  // Sequence is scoped to the institution TYPE, so schools, colleges and
  // coaching institutes each number independently starting from 0001 — e.g.
  // the first college created is QX-{ABBR}-{year}-0001 regardless of how many
  // schools already exist (rather than one continuous counter across all types).
  const existing = await prisma.institution.count({ where: { type: type as never } });
  const seq = String(existing + 1).padStart(4, "0");

  return `QX-${prefix}-${year}-${seq}`;
}
