import { describe, expect, it } from "vitest";
import { localDateParts, renderDigest } from "../src/digest";

// loadDigestSections and runDailyDigest (the D1-touching half) are covered
// against the real schema in tests/integration/digest.test.ts — their old
// SQL-substring-fake tests here were strictly redundant with that and just as
// brittle, so they were deleted rather than duplicated.

describe("renderDigest", () => {
  it("returns null when every section is empty", () => {
    expect(renderDigest({ dueSoon: [], notices: [], changes: [] }, "2026-09-26", "Australia/Melbourne")).toBeNull();
  });

  it("renders a due-soon section with a linked title and the due date", () => {
    const rendered = renderDigest(
      { dueSoon: [{ title: "Assignment 2", url: "https://example.edu/a2", dueAt: "2026-09-30T06:00:00.000Z" }], notices: [], changes: [] },
      "2026-09-26",
      "Australia/Melbourne",
    );

    expect(rendered?.title).toContain("2026-09-26");
    expect(rendered?.body).toContain("## Due soon");
    expect(rendered?.body).toContain("[Assignment 2](https://example.edu/a2)");
    expect(rendered?.body).toContain("due Wed, 30 Sept, 4:00 pm");
  });

  it("names the deadline's local day, not its UTC day", () => {
    // 6 Oct 00:00 in Melbourne (AEDT) is 5 Oct 13:00 UTC.
    const rendered = renderDigest(
      { dueSoon: [{ title: "Lab 9", url: null, dueAt: "2026-10-05T13:00:00.000Z" }], notices: [], changes: [] },
      "2026-10-04",
      "Australia/Melbourne",
    );

    expect(rendered?.body).toContain("due Tue, 6 Oct, 12:00 am");
  });

  it("renders notices and changes as separate sections with plain titles when there is no url", () => {
    const rendered = renderDigest(
      {
        dueSoon: [],
        notices: [{ title: "Lecture cancelled Friday", type: "notice.posted", url: null }],
        changes: [{ title: "Assignment 2", type: "grade.changed", url: null }],
      },
      "2026-09-26",
      "Australia/Melbourne",
    );

    expect(rendered?.body).toContain("## Notices");
    expect(rendered?.body).toContain("- Lecture cancelled Friday");
    expect(rendered?.body).toContain("## Changes");
    expect(rendered?.body).toContain("- Assignment 2 (grade released)");
  });
});

describe("localDateParts", () => {
  it("computes the local date and hour for a given IANA timezone", () => {
    // 2026-09-26T20:30:00Z is 2026-09-27T06:30 in Australia/Melbourne (AEST/AEDT +10/+11).
    const { date, hour } = localDateParts(new Date("2026-09-26T20:30:00.000Z"), "Australia/Melbourne");
    expect(date).toBe("2026-09-27");
    expect(hour).toBeGreaterThanOrEqual(6);
    expect(hour).toBeLessThanOrEqual(7);
  });

  it("agrees with UTC when given the UTC timezone", () => {
    const { date, hour } = localDateParts(new Date("2026-09-26T07:00:00.000Z"), "UTC");
    expect(date).toBe("2026-09-26");
    expect(hour).toBe(7);
  });
});

