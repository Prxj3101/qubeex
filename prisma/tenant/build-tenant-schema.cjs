/**
 * Builds prisma/tenant/schema.prisma — the academic-only (BYOD tenant) schema —
 * from the central prisma/schema.prisma using the PLATFORM/ACADEMIC classification
 * in src/services/modelClassification.ts.
 *
 * Academic models are copied verbatim EXCEPT relation fields whose type is a
 * platform model (Institution/User/...) are dropped; their scalar FK columns
 * (institutionId, userId, ...) are kept as plain columns (no cross-DB FKs).
 *
 * Run after any change to academic models in the central schema:
 *   node prisma/tenant/build-tenant-schema.cjs && npm run db:generate:tenant
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const cls = fs.readFileSync(path.join(root, "src/services/modelClassification.ts"), "utf8");

const grab = (name) => {
  const m = cls.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  return [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
};
const PLATFORM = new Set(grab("PLATFORM_MODELS"));
const ACADEMIC = new Set(grab("ACADEMIC_MODELS"));

const lines = schema.split("\n");
const out = [
  "// AUTO-GENERATED tenant (academic-only) schema for BYOD. Do not edit by hand.",
  "// Regenerate: node prisma/tenant/build-tenant-schema.cjs",
  "",
  "generator client {",
  '  provider = "prisma-client"',
  '  output   = "../../src/generated/tenant-pg"',
  "}",
  "",
  "datasource db {",
  '  provider = "postgresql"',
  "}",
  "",
];

const bareType = (t) => t.replace(/[?[\]]/g, "");
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  const enumM = line.match(/^enum\s+(\w+)\s+\{/);
  const modelM = line.match(/^model\s+(\w+)\s+\{/);
  if (enumM) {
    while (i < lines.length && lines[i].trim() !== "}") { out.push(lines[i]); i++; }
    out.push("}", ""); i++;
    continue;
  }
  if (modelM) {
    const name = modelM[1];
    const block = [line];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "}") { block.push(lines[j]); j++; }
    block.push("}");
    i = j + 1;
    if (!ACADEMIC.has(name)) continue;
    const kept = block.filter((bl, idx) => {
      if (idx === 0 || bl.trim() === "}") return true;
      const fm = bl.match(/^\s+(\w+)\s+([A-Za-z_]\w*)(\?|\[\])?(\s|$)/);
      if (fm && PLATFORM.has(bareType(fm[2]))) return false; // drop relation field to a platform model
      return true;
    });
    out.push(...kept, "");
    continue;
  }
  i++;
}

fs.writeFileSync(path.join(root, "prisma/tenant/schema.prisma"), out.join("\n"));
console.log("Wrote prisma/tenant/schema.prisma");
