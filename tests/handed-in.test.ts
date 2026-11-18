import { describe, expect, it } from "vitest";
import { isHandedIn } from "../src/panel-kit";

describe("isHandedIn", () => {
  it("treats submitted and graded work as handed in, whatever the case", () => {
    expect(isHandedIn("submitted")).toBe(true);
    expect(isHandedIn("Graded")).toBe(true);
  });

  it("treats open or unknown work as not handed in", () => {
    expect(isHandedIn(null)).toBe(false);
    expect(isHandedIn("new")).toBe(false);
    expect(isHandedIn("draft")).toBe(false);
  });
});
