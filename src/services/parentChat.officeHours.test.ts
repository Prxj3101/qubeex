import { isWithinOfficeHours } from "./parentChat.service";

// 2026-10-23 06:30 UTC = 12:00 IST; 2026-10-22 20:30 UTC = 02:00 IST
const noonIst = new Date("2026-10-23T06:30:00Z");
const twoAmIst = new Date("2026-10-22T20:30:00Z");

describe("isWithinOfficeHours (IST)", () => {
  const day = { enabled: true, officeStart: "08:00", officeEnd: "18:00" };

  it("is open inside the window", () => {
    expect(isWithinOfficeHours(day, noonIst)).toBe(true);
  });

  it("is closed outside the window", () => {
    expect(isWithinOfficeHours(day, twoAmIst)).toBe(false);
  });

  it("treats the end minute as closed", () => {
    expect(isWithinOfficeHours({ ...day, officeEnd: "12:00" }, noonIst)).toBe(false);
  });

  it("supports windows that span midnight", () => {
    const night = { enabled: true, officeStart: "22:00", officeEnd: "06:00" };
    expect(isWithinOfficeHours(night, twoAmIst)).toBe(true);
    expect(isWithinOfficeHours(night, noonIst)).toBe(false);
  });

  it("is always open when start equals end", () => {
    const always = { enabled: true, officeStart: "00:00", officeEnd: "00:00" };
    expect(isWithinOfficeHours(always, twoAmIst)).toBe(true);
    expect(isWithinOfficeHours(always, noonIst)).toBe(true);
  });
});
