import { describe, expect, it } from "vitest";
import { dayLabel, formatRelativeTime, groupByDay, phraseChange } from "../src/widgets/format.js";

const TZ = "Australia/Melbourne";
// A fixed "now" so every test is deterministic regardless of when it runs.
const NOW = new Date("2026-09-26T10:00:00.000Z"); // 2026-09-26 20:00 in Melbourne (+10)

describe("dayLabel", () => {
  it("labels the same calendar day as Today", () => {
    expect(dayLabel("2026-09-26T12:00:00.000Z", NOW, TZ)).toBe("Today");
  });

  it("labels the next calendar day as Tomorrow", () => {
    expect(dayLabel("2026-09-27T01:00:00.000Z", NOW, TZ)).toBe("Tomorrow");
  });

  it("labels a day within the next week by weekday name", () => {
    // 2026-09-30 is a Wednesday in Melbourne.
    expect(dayLabel("2026-09-30T05:00:00.000Z", NOW, TZ)).toBe("Wednesday");
  });

  it("labels a day a week or more out with a calendar date", () => {
    expect(dayLabel("2026-10-15T05:00:00.000Z", NOW, TZ)).toMatch(/Oct/);
  });
});

describe("groupByDay", () => {
  const items = [
    { title: "overdue one", dueAt: "2026-09-24T05:00:00.000Z" },
    { title: "today one", dueAt: "2026-09-26T12:00:00.000Z" },
    { title: "tomorrow one", dueAt: "2026-09-27T02:00:00.000Z" },
    { title: "no date", dueAt: null },
  ];

  it("puts a past-due item in an Overdue group first", () => {
    const groups = groupByDay(items, NOW, TZ);
    expect(groups[0]).toMatchObject({ key: "overdue", label: "Overdue", overdue: true });
    expect(groups[0].items.map((item: any) => item.title)).toEqual(["overdue one"]);
  });

  it("orders same-day and future groups chronologically after Overdue", () => {
    const groups = groupByDay(items, NOW, TZ);
    expect(groups.map((group) => group.label)).toEqual(["Overdue", "Today", "Tomorrow"]);
  });

  it("drops items without a dueAt", () => {
    const groups = groupByDay(items, NOW, TZ);
    const allTitles = groups.flatMap((group) => group.items.map((item: any) => item.title));
    expect(allTitles).not.toContain("no date");
  });

  it("returns no Overdue group when nothing is overdue", () => {
    const groups = groupByDay([{ title: "future", dueAt: "2026-09-27T02:00:00.000Z" }], NOW, TZ);
    expect(groups.every((group) => !group.overdue)).toBe(true);
  });
});

describe("formatRelativeTime", () => {
  it("renders a past instant in the past tense", () => {
    expect(formatRelativeTime("2026-09-25T10:00:00.000Z", NOW)).toMatch(/yesterday|1 day ago/);
  });

  it("renders a future instant in the future tense", () => {
    expect(formatRelativeTime("2026-09-27T10:00:00.000Z", NOW)).toMatch(/tomorrow|in 1 day/);
  });

  it("returns null for a missing or invalid instant", () => {
    expect(formatRelativeTime(null, NOW)).toBeNull();
    expect(formatRelativeTime("not-a-date", NOW)).toBeNull();
  });
});

describe("phraseChange", () => {
  it("phrases a deadline change with both timestamps", () => {
    const phrase = phraseChange(
      { type: "deadline.changed", before: "2026-10-03T23:55:00.000Z", after: "2026-10-06T09:00:00.000Z" },
      TZ,
    );
    expect(phrase).toContain("Deadline moved");
    expect(phrase).toContain("→");
  });

  it("phrases a grade change with both values", () => {
    expect(phraseChange({ type: "grade.changed", before: 78, after: 84 }, TZ)).toBe("Grade 78 → 84");
  });

  it("phrases a posted notice using the item title", () => {
    expect(phraseChange({ type: "notice.posted", title: "Exam format clarified" }, TZ)).toBe(
      "New staff notice: Exam format clarified",
    );
  });

  it("falls back to the raw type for an event type it does not recognise", () => {
    expect(phraseChange({ type: "some.future.type", title: "X" }, TZ)).toBe("X");
  });
});
