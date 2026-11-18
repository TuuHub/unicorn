import { describe, expect, it } from "vitest";
import { labelStructure } from "../src/kernel/courses";
import { D1ItemStore } from "../src/kernel/d1-item-store";
import { Kernel } from "../src/kernel/kernel";
import type { ItemInput } from "../src/kernel/types";
import { loadGrades, renderGradesWidget, scoreHtml } from "../src/panel-grades";
import { createTestDb } from "./support/sqlite-d1";

const course: ItemInput = {
  id: "course:1",
  source: "campus-moodle",
  kind: "course",
  title: "FIT2094 Databases",
  timestamp: "2026-07-27T00:00:00.000Z",
  raw: {},
  facets: [{ type: "course-identity", data: { platform: "moodle", platformId: "1", code: "FIT2094_S2_2026", status: "active" }, capabilities: [] }],
};

function grade(cmid: number, title: string, value: string | null, range: string, order: number): ItemInput {
  return {
    id: `grade:${cmid}`,
    source: "campus-moodle",
    kind: "grade",
    title,
    timestamp: "2026-07-27T00:00:00.000Z",
    url: `https://m.example.edu/mod/assign/view.php?id=${cmid}`,
    raw: {},
    facets: [
      { type: "course-membership", data: { course: "course:1" }, capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }] },
      { type: "grade", data: { grade: value ?? "", range, status: value ? "Pass" : null, order }, capabilities: [{ name: "has-grade", primitive: "state", field: "grade" }] },
    ],
  };
}

describe("grades", () => {
  it("lists marked work by unit with its score, newest marks first", async () => {
    const db = await createTestDb();
    const kernel = new Kernel(new D1ItemStore(db));
    await kernel.ingest([course, grade(10, "Assignment 1 (30%)", "99.00 (HD)", "0–100", 0), grade(11, "Assignment 2 (30%)", null, "0–100", 1), grade(12, "Class Test 2", "14.25", "0–15", 2)]);
    await labelStructure(db);

    const rows = await loadGrades(db);

    expect(rows.map((row) => [row.course, row.title, row.grade])).toEqual(
      expect.arrayContaining([
        ["FIT2094", "Assignment 1 (30%)", "99.00 (HD)"],
        ["FIT2094", "Assignment 2 (30%)", null],
      ]),
    );
    const widget = renderGradesWidget(rows);
    expect(widget.indexOf("Class Test 2")).toBeLessThan(widget.indexOf("Assignment 1"));
    expect(widget).not.toContain("Assignment 2");
    expect(scoreHtml(rows.find((row) => row.title === "Assignment 1 (30%)")!)).toContain('99<span class="faint"> / 100</span></span> <span class="badge ok">HD</span>');
    expect(scoreHtml(rows.find((row) => row.title === "Assignment 2 (30%)")!)).toContain("Not marked");
  });
});
