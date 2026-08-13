import { runWithAcademicClient, academicDb, hasAcademicContext, type AcademicClient } from "./academicContext";

describe("academic context (AsyncLocalStorage)", () => {
  it("returns the client set for the current scope", () => {
    const fake = { marker: 1 } as unknown as AcademicClient;
    const got = runWithAcademicClient(fake, () => academicDb());
    expect(got).toBe(fake);
  });

  it("throws when used outside a context", () => {
    expect(() => academicDb()).toThrow(/no academic client/i);
  });

  it("hasAcademicContext reflects the scope", () => {
    expect(hasAcademicContext()).toBe(false);
    const inside = runWithAcademicClient({} as unknown as AcademicClient, () => hasAcademicContext());
    expect(inside).toBe(true);
  });

  it("isolates nested scopes", () => {
    const a = { id: "a" } as unknown as AcademicClient;
    const b = { id: "b" } as unknown as AcademicClient;
    const result = runWithAcademicClient(a, () => {
      const inner = runWithAcademicClient(b, () => academicDb());
      return { outer: academicDb(), inner };
    });
    expect(result.outer).toBe(a);
    expect(result.inner).toBe(b);
  });
});
