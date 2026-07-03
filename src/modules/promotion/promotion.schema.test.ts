import { promoteStudentsSchema } from "./promotion.schema";

describe("promoteStudentsSchema", () => {
  it("accepts a valid PROMOTE payload", () => {
    const result = promoteStudentsSchema.safeParse({
      studentIds: ["s1", "s2"],
      action: "PROMOTE",
      targetDivisionId: "d1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid GRADUATE payload without targetDivisionId", () => {
    const result = promoteStudentsSchema.safeParse({
      studentIds: ["s1"],
      action: "GRADUATE",
    });
    expect(result.success).toBe(true);
  });

  it("rejects PROMOTE without targetDivisionId", () => {
    const result = promoteStudentsSchema.safeParse({
      studentIds: ["s1"],
      action: "PROMOTE",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty studentIds array", () => {
    const result = promoteStudentsSchema.safeParse({
      studentIds: [],
      action: "GRADUATE",
    });
    expect(result.success).toBe(false);
  });
});
