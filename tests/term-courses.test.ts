import { describe, expect, it } from "vitest";
import { loadTermCourses } from "../src/term";

type Row = { code: string; term: string | null; title: string | null; source: string };

function fakeDb(rows: Row[]): D1Database {
  return { prepare: () => ({ all: async () => ({ results: rows }) }) } as unknown as D1Database;
}

describe("loadTermCourses", () => {
  it("merges a unit's Moodle offering code and Ed code into one unit", async () => {
    const courses = await loadTermCourses(
      fakeDb([
        { code: "FIT2004", term: "S2 2026", title: "Algorithms and data structures", source: "ed" },
        { code: "FIT2004_S2_2026", term: "S2_2026", title: "FIT2004 Algorithms and data structures", source: "moodle" },
        { code: "MAT1830", term: null, title: null, source: "ed" },
      ]),
    );

    expect(courses.map((course) => course.code)).toEqual(["FIT2004", "MAT1830"]);
    expect(courses[0]).toMatchObject({ term: "S2 2026", title: "Algorithms and data structures" });
    expect(courses[0]!.sources).toHaveLength(2);
  });
});
