import { describe, expect, it } from "vitest";
import { courseMentionFacet, extractUnitCodes } from "../src/plugins/course-mention";

describe("extractUnitCodes", () => {
  it("matches unit codes across multiple texts, de-duplicated and sorted", () => {
    expect(extractUnitCodes("Re: FIT2004 assignment", "See also FIT1045 and FIT2004 lab notes")).toEqual([
      "FIT1045",
      "FIT2004",
    ]);
  });

  it("ignores lowercase and malformed lookalikes", () => {
    expect(extractUnitCodes("fit2004 is not a match, nor is FIT204 or FIT20044")).toEqual([]);
  });

  it("skips undefined and null texts", () => {
    expect(extractUnitCodes(undefined, null, "MAT1830 extension granted")).toEqual(["MAT1830"]);
  });

  it("returns an empty array when there are no mentions", () => {
    expect(extractUnitCodes("no unit codes here")).toEqual([]);
  });
});

describe("courseMentionFacet", () => {
  it("builds a course-mention facet with the mentions-course relation capability", () => {
    expect(courseMentionFacet(["FIT2004"])).toEqual({
      type: "course-mention",
      data: { codes: ["FIT2004"] },
      capabilities: [{ name: "mentions-course", primitive: "relation", field: "codes" }],
    });
  });

  it("omits the facet entirely when there are no codes", () => {
    expect(courseMentionFacet([])).toBeUndefined();
  });
});
