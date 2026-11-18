import { describe, expect, it } from "vitest";
import { bandFor, percentOf } from "../src/grade-scale";

describe("grade scale", () => {
  it("turns a mark and its range into a percentage", () => {
    expect(percentOf("27.50", "0–28")).toBe(98);
    expect(percentOf("99.00 (HD)", "0–100")).toBe(99);
    expect(percentOf("4", "0-5")).toBe(80);
    expect(percentOf("Satisfactory", "0–1")).toBeNull();
    expect(percentOf("12", null)).toBeNull();
  });

  it("names the band each school gives a percentage", () => {
    expect(bandFor(80, "monash")?.label).toBe("HD");
    expect(bandFor(79, "monash")?.label).toBe("D");
    expect(bandFor(49, "monash")).toMatchObject({ label: "N", tier: 5 });
    expect(bandFor(77, "melbourne")?.label).toBe("H2A");
    expect(bandFor(65, "uk")?.label).toBe("2:1");
    expect(bandFor(95, "percent")).toBeNull();
  });
});
