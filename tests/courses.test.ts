import { describe, expect, it } from "vitest";
import {
  bucketSlug,
  labelStructure,
  matchCategoryToAssessment,
  normalizeCourseCode,
  normalizeTerm,
} from "../src/kernel/courses";

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

// Minimal in-memory D1 double: routes SELECTs by a substring of the SQL
// (each query's own facet/table type name is unique across the five queries
// labelStructure issues), and captures batched UPDATE statements so its
// writes are provable.
function fakeDb(routes: Array<{ match: string; rows: unknown[] }>) {
  const updates: Array<{ sql: string; values: unknown[] }> = [];
  function statement(sql: string, values: unknown[] = []) {
    return {
      bind: (...boundValues: unknown[]) => statement(sql, boundValues),
      all: async () => {
        const route = routes.find((candidate) => sql.includes(candidate.match));
        return { results: route?.rows ?? [] };
      },
      run: async () => {
        updates.push({ sql, values });
        return { meta: { changes: 1 } };
      },
    };
  }
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<ReturnType<typeof statement>>) => {
      for (const stmt of statements) {
        await stmt.run();
      }
      return [];
    },
  } as unknown as D1Database;
  return { db, updates };
}

describe("labelStructure", () => {
  it("labels an assessment with its course code and an assessment-title bucket", async () => {
    const { db, updates } = fakeDb([
      { match: "'course-identity'", rows: [{ source: "campus-moodle", item_id: "course:1", data_json: "FIT2004" }] },
      {
        match: "labeled_by IS NULL OR labeled_by = 'structure'",
        rows: [{ source: "campus-moodle", item_id: "assessment:9", kind: "assessment", title: "Assignment 2" }],
      },
      { match: "'course-membership'", rows: [{ source: "campus-moodle", item_id: "assessment:9", data_json: "course:1" }] },
      { match: "'course-mention'", rows: [] },
      { match: "'discussion-category'", rows: [] },
    ]);

    const result = await labelStructure(db);

    expect(result).toEqual({ labeled: 1 });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.values).toEqual(["FIT2004", "course/FIT2004/assignment-2", "campus-moodle", "assessment:9"]);
  });

  it("buckets a matched thread under its assessment and an unmatched one under general", async () => {
    const { db, updates } = fakeDb([
      {
        // Each source has its own course item, so a same-source membership
        // reference resolves against a same-source identity row.
        match: "'course-identity'",
        rows: [
          { source: "campus-moodle", item_id: "course:1", data_json: "FIT2004" },
          { source: "campus-ed", item_id: "course:1", data_json: "FIT2004" },
        ],
      },
      {
        match: "labeled_by IS NULL OR labeled_by = 'structure'",
        rows: [
          { source: "campus-moodle", item_id: "assessment:9", kind: "assessment", title: "Assignment 2" },
          { source: "campus-ed", item_id: "thread:1", kind: "thread", title: "Question about assignment 2" },
          { source: "campus-ed", item_id: "thread:2", kind: "thread", title: "Off topic chat" },
        ],
      },
      {
        match: "'course-membership'",
        rows: [
          { source: "campus-moodle", item_id: "assessment:9", data_json: "course:1" },
          { source: "campus-ed", item_id: "thread:1", data_json: "course:1" },
          { source: "campus-ed", item_id: "thread:2", data_json: "course:1" },
        ],
      },
      { match: "'course-mention'", rows: [] },
      {
        match: "'discussion-category'",
        rows: [{ source: "campus-ed", item_id: "thread:1", data_json: "Assignment 2" }],
      },
    ]);

    const result = await labelStructure(db);

    expect(result).toEqual({ labeled: 3 });
    const bySubject = new Map(updates.map((update) => [update.values[3], update.values[1]]));
    expect(bySubject.get("assessment:9")).toBe("course/FIT2004/assignment-2");
    expect(bySubject.get("thread:1")).toBe("course/FIT2004/assignment-2");
    expect(bySubject.get("thread:2")).toBe("course/FIT2004/general");
  });

  it("leaves an item unlabeled when no course can be resolved", async () => {
    const { db, updates } = fakeDb([
      { match: "'course-identity'", rows: [] },
      {
        match: "labeled_by IS NULL OR labeled_by = 'structure'",
        rows: [{ source: "life-gmail", item_id: "email:1", kind: "email", title: "Welcome" }],
      },
      { match: "'course-membership'", rows: [] },
      { match: "'course-mention'", rows: [] },
      { match: "'discussion-category'", rows: [] },
    ]);

    const result = await labelStructure(db);

    expect(result).toEqual({ labeled: 0 });
    expect(updates).toHaveLength(0);
  });

  it("resolves a course from a unique course-mention when there is no membership or identity", async () => {
    const { db, updates } = fakeDb([
      { match: "'course-identity'", rows: [] },
      {
        match: "labeled_by IS NULL OR labeled_by = 'structure'",
        rows: [{ source: "life-gmail", item_id: "email:1", kind: "email", title: "Re: FIT2004 extension" }],
      },
      { match: "'course-membership'", rows: [] },
      {
        match: "'course-mention'",
        rows: [{ source: "life-gmail", item_id: "email:1", data_json: JSON.stringify({ codes: ["FIT2004"] }) }],
      },
      { match: "'discussion-category'", rows: [] },
    ]);

    const result = await labelStructure(db);

    expect(result).toEqual({ labeled: 1 });
    expect(updates[0]?.values).toEqual(["FIT2004", "course/FIT2004/general", "life-gmail", "email:1"]);
  });
});
