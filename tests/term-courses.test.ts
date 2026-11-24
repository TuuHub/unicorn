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

  it("drops hubs, reads Moodle's term from its code and keeps only the latest term", async () => {
    const courses = await loadTermCourses(
      fakeDb([
        { code: "ATS2946 - S2 2026", term: null, title: "ATS2946 - Critical thinking - Semester 2 2026", source: "campus-moodle" },
        { code: "FIT1045_S2_2025", term: null, title: "FIT1045 Introduction to programming - S2 2025", source: "campus-moodle" },
        { code: "FIT2099_S1_2026", term: null, title: "FIT2099 Object oriented design - S1 2026", source: "campus-moodle" },
        { code: "FIT2014", term: "SEMESTER 2 2026", title: "Theory of computation", source: "campus-ed" },
        { code: "FIT2014_S2_2026", term: null, title: "FIT2014 Theory of computation - S2 2026", source: "campus-moodle" },
        { code: "SOIT Student HUB UG", term: null, title: "MUM School of IT - Undergraduate Student Hub", source: "campus-moodle" },
        { code: "FIT-Student-Portal", term: null, title: "IT Student Portal", source: "campus-moodle" },
      ]),
    );

    expect(courses.map((course) => [course.code, course.term])).toEqual([
      ["ATS2946", "S2 2026"],
      ["FIT2014", "S2 2026"],
    ]);
    expect(courses[1]!.sources).toEqual(["Ed", "Moodle"]);
  });

  it("orders terms by year before period", async () => {
    const courses = await loadTermCourses(
      fakeDb([
        { code: "FIT1008_S2_2026", term: null, title: null, source: "campus-moodle" },
        { code: "FIT3155_S1_2027", term: null, title: null, source: "campus-moodle" },
      ]),
    );

    expect(courses.map((course) => course.code)).toEqual(["FIT3155"]);
  });
});
