import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("POST /superadmin/institutions — abbreviation-driven codes", () => {
  let superAdminToken: string;
  let createdInstitutionId: string | undefined;
  let createdInstitutionIdB: string | undefined;
  let institutionCountBefore: number;
  // Unique per test run so pre-existing institutions in the shared dev DB
  // (including any real institution that happens to already use a common
  // abbreviation) can never collide with this test's disambiguator
  // expectations.
  const suffix = `${Date.now()}`;
  const abbreviation = `T${suffix.slice(-3)}`; // 4 chars, unique per run

  beforeAll(async () => {
    const superAdminUser = await prisma.user.create({
      data: { name: "Test SuperAdmin", email: `superadmin-ci-${suffix}@example.com`, role: "SUPER_ADMIN", isActive: true },
    });
    superAdminToken = jwt.sign({ userId: superAdminUser.id, role: "SUPER_ADMIN" }, process.env.JWT_SECRET!);

    // The institutionCode sequence is scoped to the institution TYPE (schools,
    // colleges and coaching each number independently from 0001). Both
    // institutions this test creates are SCHOOL, so we record the current SCHOOL
    // count to compute the expected sequence rather than assuming a clean slate.
    institutionCountBefore = await prisma.institution.count({ where: { type: "SCHOOL", isDemo: false } });
  });

  afterAll(async () => {
    for (const id of [createdInstitutionId, createdInstitutionIdB]) {
      if (!id) continue;
      await prisma.invite.deleteMany({ where: { institutionId: id } });
      await prisma.subscription.deleteMany({ where: { institutionId: id } });
      // UserStatusEvent FK-restricts on userId, so it must go before the
      // users it references — otherwise institution.delete below fails
      // silently (caught below) and leaves this test's institution orphaned
      // in the shared dev DB on every run.
      await prisma.userStatusEvent.deleteMany({ where: { institutionId: id } });
      await prisma.user.deleteMany({ where: { institutionId: id } });
      await prisma.institution.delete({ where: { id } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { email: { contains: `-ci-${suffix}@example.com` } } });
    await prisma.$disconnect();
  });

  it("uses the superadmin-provided abbreviation in both institutionCode and userIdPrefix, and persists admin phone/dob/gender/establishedOn entered at creation time", async () => {
    const res = await request(app)
      .post("/api/superadmin/institutions")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({
        name: "Sri Krishna Public School",
        email: `inst-ci-a-${suffix}@example.com`,
        type: "SCHOOL",
        abbreviation: abbreviation.toLowerCase(),
        adminName: "Test Admin",
        adminEmail: `admin-ci-a-${suffix}@example.com`,
        adminPhone: "+91 98765 43210",
        adminDob: "1985-03-15",
        adminGender: "Male",
        establishedOn: "1995-06-01",
      });

    expect(res.status).toBe(201);
    createdInstitutionId = res.body.data.id;

    const institution = await prisma.institution.findUniqueOrThrow({ where: { id: createdInstitutionId } });
    const yy = String(new Date().getFullYear()).slice(-2);
    const expectedSeq = String(institutionCountBefore + 1).padStart(4, "0");
    expect(institution.institutionCode).toBe(`QX-${abbreviation}-SC${yy}-${expectedSeq}`);
    expect(institution.userIdPrefix).toBe(abbreviation);
    expect(institution.userIdDisambiguator).toBe("01");

    // Previously silently dropped by the zod schema — must actually persist now.
    expect(institution.adminPhone).toBe("+91 98765 43210");
    expect(institution.adminDob).toBe("1985-03-15");
    expect(institution.adminGender).toBe("Male");
    expect(institution.establishedOn).toBe("1995-06-01");

    const admin = await prisma.user.findFirst({ where: { institutionId: createdInstitutionId, role: "ADMIN" } });
    expect(admin?.displayId).toBe(`${abbreviation}-01A${String(year).slice(-2)}-0001`);
  });

  it("rejects an abbreviation that isn't exactly 4 alphanumeric characters", async () => {
    const res = await request(app)
      .post("/api/superadmin/institutions")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({
        name: "Test Bad Abbreviation School",
        email: `inst-ci-bad-${suffix}@example.com`,
        type: "SCHOOL",
        abbreviation: "AB",
        adminName: "Test Admin",
        adminEmail: `admin-ci-bad-${suffix}@example.com`,
      });

    expect(res.status).toBe(400);
  });

  it("assigns a distinct disambiguator to a second institution sharing the same abbreviation, with the sequence continuing within the type (not resetting per abbreviation)", async () => {
    const res = await request(app)
      .post("/api/superadmin/institutions")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({
        name: "Sri Krishna Public School Branch 2",
        email: `inst-ci-b-${suffix}@example.com`,
        type: "SCHOOL",
        abbreviation,
        adminName: "Test Admin 2",
        adminEmail: `admin-ci-b-${suffix}@example.com`,
      });

    expect(res.status).toBe(201);
    createdInstitutionIdB = res.body.data.id;

    const institution = await prisma.institution.findUniqueOrThrow({ where: { id: createdInstitutionIdB } });
    const yy = String(new Date().getFullYear()).slice(-2);
    const expectedSeq = String(institutionCountBefore + 2).padStart(4, "0");
    expect(institution.institutionCode).toBe(`QX-${abbreviation}-SC${yy}-${expectedSeq}`);
    expect(institution.userIdPrefix).toBe(abbreviation);
    expect(institution.userIdDisambiguator).toBe("02");
  });
});
