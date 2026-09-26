import { describe, expect, it } from "vitest";
import { bucketSlug, matchCategoryToAssessment, normalizeCourseCode, normalizeTerm } from "../src/kernel/courses";

describe("normalizeCourseCode", () => {
  it("extracts the leading unit code from an offering string", () => {
    expect(normalizeCourseCode("FIT2004 S1 2026")).toBe("FIT2004");
  });

  it("uppercases and strips internal whitespace before matching", () => {
    expect(normalizeCourseCode("  fit 2004 ")).toBe("FIT2004");
  });

  it("matches a trailing letter suffix", () => {
    expect(normalizeCourseCode("CHEM1011A_S2_2026")).toBe("CHEM1011A");
  });

  it("returns null when no unit code is found", () => {
    expect(normalizeCourseCode("General discussion")).toBeNull();
  });
});

describe("normalizeTerm", () => {
  it("canonicalizes separators and case", () => {
    expect(normalizeTerm("s2_2026")).toBe("S2 2026");
    expect(normalizeTerm("S2-2026")).toBe("S2 2026");
    expect(normalizeTerm("  S2   2026  ")).toBe("S2 2026");
  });

  it("returns null for empty or missing input", () => {
    expect(normalizeTerm("")).toBeNull();
    expect(normalizeTerm(null)).toBeNull();
    expect(normalizeTerm(undefined)).toBeNull();
  });
});

describe("bucketSlug", () => {
  it("lowercases and kebab-cases a title", () => {
    expect(bucketSlug("Assignment 2: Design Report")).toBe("assignment-2-design-report");
  });

  it("strips diacritics", () => {
    expect(bucketSlug("Résumé Café")).toBe("resume-cafe");
  });

  it("caps length at 48 characters with no trailing dash", () => {
    const long = "A".repeat(60);
    const slug = bucketSlug(long);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("matchCategoryToAssessment", () => {
  const titles = ["Assignment 1", "Assignment 2", "Weekly Quiz"];

  it("matches on normalized equality", () => {
    expect(matchCategoryToAssessment("assignment-2", titles)).toBe("Assignment 2");
  });

  it("matches a unique word-boundary prefix", () => {
    expect(matchCategoryToAssessment("Assignment", ["Assignment 1"])).toBe("Assignment 1");
  });

  it("returns null when a prefix match is ambiguous between two titles", () => {
    expect(matchCategoryToAssessment("Assignment", titles)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(matchCategoryToAssessment("Off-topic", titles)).toBeNull();
  });
});
