import fs from "fs";
import path from "path";
import { PLATFORM_MODELS, ACADEMIC_MODELS, isAcademicModel } from "./modelClassification";

describe("BYOD model classification", () => {
  it("puts platform/SaaS models in PLATFORM_MODELS", () => {
    for (const m of ["User", "Institution", "Subscription", "InstitutionDbConfig"]) {
      expect(PLATFORM_MODELS).toContain(m);
    }
  });

  it("puts academic models in ACADEMIC_MODELS", () => {
    for (const m of ["Student", "Attendance", "Marksheet"]) {
      expect(ACADEMIC_MODELS).toContain(m);
    }
  });

  it("has no overlap between the two lists", () => {
    const platform = new Set<string>(PLATFORM_MODELS);
    const overlap = ACADEMIC_MODELS.filter((m) => platform.has(m));
    expect(overlap).toEqual([]);
  });

  it("isAcademicModel reflects the academic set", () => {
    expect(isAcademicModel("Attendance")).toBe(true);
    expect(isAcademicModel("Student")).toBe(true);
    expect(isAcademicModel("User")).toBe(false);
    expect(isAcademicModel("Institution")).toBe(false);
  });

  it("classifies every schema model exactly once (completeness)", () => {
    const schema = fs.readFileSync(
      path.join(__dirname, "..", "..", "prisma", "schema.prisma"),
      "utf8"
    );
    const schemaModels = Array.from(schema.matchAll(/^model\s+(\w+)\s+\{/gm)).map((m) => m[1]);

    const classified = new Set<string>([...PLATFORM_MODELS, ...ACADEMIC_MODELS]);

    // Every schema model must be classified.
    const unclassified = schemaModels.filter((m) => !classified.has(m));
    expect(unclassified).toEqual([]);

    // Every classified name must exist in the schema (no stale entries).
    const schemaSet = new Set(schemaModels);
    const stale = [...PLATFORM_MODELS, ...ACADEMIC_MODELS].filter((m) => !schemaSet.has(m));
    expect(stale).toEqual([]);

    // Counts line up exactly (no dupes, nothing missed).
    expect(PLATFORM_MODELS.length + ACADEMIC_MODELS.length).toBe(schemaModels.length);
  });
});
