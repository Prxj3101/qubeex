import { prisma } from "./prisma";

// 2-letter code per institution type, embedded in the institute code so the
// type is visible at a glance (e.g. QX-DEHS-SC26-0001 for a school).
const TYPE_CODE: Record<string, string> = {
  SCHOOL: "SC",
  COLLEGE: "CL",
  COACHING: "CH",
};

export async function generateInstitutionCode(
  abbreviation: string,
  type: string,
  isDemo = false
): Promise<string> {
  const prefix = abbreviation.toUpperCase();
  const typeCode = TYPE_CODE[type] ?? "XX";
  const yy = String(new Date().getFullYear()).slice(-2);
  const typeYear = `${typeCode}${yy}`;

  // The demo institute always gets sequence 0000 and is never counted below,
  // so the first real institute of a type is always 0001 regardless of
  // whether a demo institute exists for that type.
  if (isDemo) {
    return `QX-${prefix}-${typeYear}-0000`;
  }

  // Sequence is scoped to the institution TYPE, so schools, colleges and
  // coaching institutes each number independently starting from 0001 — e.g.
  // the first college created is QX-{ABBR}-CL{yy}-0001 regardless of how many
  // schools already exist (rather than one continuous counter across all types).
  // Demo institutes are excluded so they never shift this sequence.
  const existing = await prisma.institution.count({ where: { type: type as never, isDemo: false } });
  const seq = String(existing + 1).padStart(4, "0");

  return `QX-${prefix}-${typeYear}-${seq}`;
}
