import { prisma } from "./prisma";
import { generateUserId } from "./userId";

describe("generateUserId — integration", () => {
  let institutionAId: string;
  let institutionBId: string; // shares "St Xavier's High School" name with A, to test disambiguator collision

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const a = await prisma.institution.create({
      data: {
        institutionCode: `TEST-UID-A-${suffix}`,
        name: "St Xavier's High School",
        email: `test-uid-a-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionAId = a.id;

    const b = await prisma.institution.create({
      data: {
        institutionCode: `TEST-UID-B-${suffix}`,
        name: "St Xavier's High School",
        email: `test-uid-b-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionBId = b.id;
  });

  afterAll(async () => {
    if (institutionAId) await prisma.institution.delete({ where: { id: institutionAId } }).catch(() => {});
    if (institutionBId) await prisma.institution.delete({ where: { id: institutionBId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("assigns the correct prefix, role letter, and join year, with sequential numbering per role", async () => {
    const joinYear = String(new Date().getFullYear()).slice(-2);

    const admin1 = await generateUserId(institutionAId, "A");
    expect(admin1).toBe(`SXHS-01A${joinYear}-0001`);

    const teacher1 = await generateUserId(institutionAId, "T");
    expect(teacher1).toBe(`SXHS-01T${joinYear}-0001`);

    const student1 = await generateUserId(institutionAId, "S");
    expect(student1).toBe(`SXHS-01S${joinYear}-0001`);

    const admin2 = await generateUserId(institutionAId, "A");
    expect(admin2).toBe(`SXHS-01A${joinYear}-0002`);

    const student2 = await generateUserId(institutionAId, "S");
    expect(student2).toBe(`SXHS-01S${joinYear}-0002`);
  });

  it("assigns a different disambiguator to a second institution sharing the same derived prefix", async () => {
    const joinYear = String(new Date().getFullYear()).slice(-2);
    const id = await generateUserId(institutionBId, "A");
    expect(id).toBe(`SXHS-02A${joinYear}-0001`);
  });

  it("reuses the same prefix/disambiguator on every subsequent call for the same institution", async () => {
    const before = await prisma.institution.findUniqueOrThrow({ where: { id: institutionAId } });
    await generateUserId(institutionAId, "T");
    const after = await prisma.institution.findUniqueOrThrow({ where: { id: institutionAId } });
    expect(after.userIdPrefix).toBe(before.userIdPrefix);
    expect(after.userIdDisambiguator).toBe(before.userIdDisambiguator);
  });
});
