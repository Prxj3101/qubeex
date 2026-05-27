import { prisma } from "./prisma";

const TYPE_PREFIX: Record<string, string> = {
  SCHOOL:   "SCH",
  COLLEGE:  "CLG",
  COACHING: "COA",
};

export async function generateInstitutionCode(type: string): Promise<string> {
  const prefix = TYPE_PREFIX[type] ?? "INS";
  const year = new Date().getFullYear();
  const base = `QX-${prefix}-${year}-`;

  const existing = await prisma.institution.count({
    where: { institutionCode: { startsWith: base } },
  });

  const seq = String(existing + 1).padStart(4, "0");
  return `${base}${seq}`;
}
