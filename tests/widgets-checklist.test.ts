import { describe, expect, it } from "vitest";
import { checklistProgress, listChecklistItems, toggleChecklistLine } from "../src/widgets/checklist.js";

const PLAN = ["## This week", "", "- [x] Review lecture 8 slides", "- [ ] Draft outline", "- [ ] Submit peer review", "", "Notes: keep Thursday free."].join(
  "\n",
);

describe("listChecklistItems", () => {
  it("finds every task line with its line index and checked state", () => {
    expect(listChecklistItems(PLAN)).toEqual([
      { line: 2, checked: true, text: "Review lecture 8 slides" },
      { line: 3, checked: false, text: "Draft outline" },
      { line: 4, checked: false, text: "Submit peer review" },
    ]);
  });

  it("ignores a bullet that is not a task item", () => {
    expect(listChecklistItems("- plain bullet\n- [ ] a task")).toEqual([{ line: 1, checked: false, text: "a task" }]);
  });
});

describe("toggleChecklistLine", () => {
  it("flips only the targeted line, leaving every other line byte-for-byte identical", () => {
    const next = toggleChecklistLine(PLAN, 3);
    const nextLines = next.split("\n");
    const originalLines = PLAN.split("\n");

    expect(nextLines[3]).toBe("- [x] Draft outline");
    for (let i = 0; i < originalLines.length; i++) {
      if (i === 3) continue;
      expect(nextLines[i]).toBe(originalLines[i]);
    }
  });

  it("unchecks an already-checked line", () => {
    const next = toggleChecklistLine(PLAN, 2);
    expect(next.split("\n")[2]).toBe("- [ ] Review lecture 8 slides");
  });

  it("preserves indentation and the bullet character used", () => {
    const indented = "  * [ ] nested task";
    expect(toggleChecklistLine(indented, 0)).toBe("  * [x] nested task");
  });

  it("returns the document unchanged for a stale index that is no longer a task line", () => {
    expect(toggleChecklistLine(PLAN, 0)).toBe(PLAN);
    expect(toggleChecklistLine(PLAN, 99)).toBe(PLAN);
  });
});

describe("checklistProgress", () => {
  it("counts done vs total", () => {
    expect(checklistProgress(PLAN)).toEqual({ done: 1, total: 3 });
  });

  it("is zero over zero when there are no task lines", () => {
    expect(checklistProgress("just prose, no tasks")).toEqual({ done: 0, total: 0 });
  });
});
