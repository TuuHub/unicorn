import { describe, expect, it } from "vitest";
import { RESULT_ROW_LIMIT, ToolGuardError, renderRows, toolErrorResult } from "../src/tools/user-tools";

describe("renderRows", () => {
  it("renders an empty result with a Next hint, no table", () => {
    const { text, rows, truncated } = renderRows([]);
    expect(text).toContain("(0 rows)");
    expect(text).toContain("Next:");
    expect(rows).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("renders a header row, a separator row and one line per data row", () => {
    const { text } = renderRows([
      { course: "FIT2004", title: "Lab report 4" },
      { course: "FIT2099", title: "Assignment 2" },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("| course | title |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| FIT2004 | Lab report 4 |");
    expect(lines[3]).toBe("| FIT2099 | Assignment 2 |");
  });

  it("states the row count and is not marked truncated under the cap", () => {
    const { text, truncated } = renderRows([{ a: 1 }, { a: 2 }]);
    expect(text).toContain("2 rows");
    expect(text).not.toContain("truncated");
    expect(truncated).toBe(false);
  });

  it("uses singular 'row' for exactly one row", () => {
    const { text } = renderRows([{ a: 1 }]);
    expect(text).toContain("1 row");
    expect(text).not.toContain("1 rows");
  });

  it("marks truncated at 200 rows and says so explicitly, with a Next hint", () => {
    const rows = Array.from({ length: RESULT_ROW_LIMIT }, (_, i) => ({ i }));
    const { text, truncated, rows: kept } = renderRows(rows);
    expect(truncated).toBe(true);
    expect(text).toContain("truncated at 200 rows");
    expect(text).toContain("Next:");
    expect(kept.length).toBe(RESULT_ROW_LIMIT);
  });

  it("does not truncate at 199 rows", () => {
    const rows = Array.from({ length: RESULT_ROW_LIMIT - 1 }, (_, i) => ({ i }));
    expect(renderRows(rows).truncated).toBe(false);
  });

  it("escapes a pipe character in a cell so it can't break the table", () => {
    const { text } = renderRows([{ title: "before | after" }]);
    expect(text).toContain("before \\| after");
  });

  it("collapses embedded newlines/whitespace in a cell to single spaces", () => {
    const { text } = renderRows([{ body: "line one\nline two" }]);
    expect(text).toContain("line one line two");
  });

  it("renders null and undefined cells as empty", () => {
    const { text } = renderRows([{ a: null, b: undefined }]);
    const dataLine = text.split("\n")[2]!;
    expect(dataLine).toMatch(/^\|\s*\|\s*\|$/);
  });

  it("JSON-stringifies a non-string, non-null cell", () => {
    const { text } = renderRows([{ tags: ["a", "b"] }]);
    expect(text).toContain(JSON.stringify(["a", "b"]));
  });

  it("truncates an individual cell's text at 200 characters", () => {
    const long = "x".repeat(500);
    const { text } = renderRows([{ title: long }]);
    const dataLine = text.split("\n")[2]!;
    // header + separators account for a few extra chars either side of the cell
    expect(dataLine.length).toBeLessThan(long.length);
    expect(dataLine).toContain("x".repeat(200));
  });
});

describe("toolErrorResult", () => {
  it("wraps a ToolGuardError's structured error verbatim", () => {
    const error = new ToolGuardError({ code: "SQL_FORBIDDEN_TABLE", message: '"items" is not allowed.', hint: "Use v_items instead." });
    const result = toolErrorResult(error);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text) as { error: { code: string; message: string; hint: string } };
    expect(parsed.error).toEqual({ code: "SQL_FORBIDDEN_TABLE", message: '"items" is not allowed.', hint: "Use v_items instead." });
  });

  it("falls back to the given code for a plain Error", () => {
    const result = toolErrorResult(new Error("D1_ERROR: no such table"), "TOOL_EXECUTION_FAILED");
    const parsed = JSON.parse(result.content[0]!.text) as { error: { code: string; message: string; hint: string } };
    expect(parsed.error.code).toBe("TOOL_EXECUTION_FAILED");
    expect(parsed.error.message).toBe("D1_ERROR: no such table");
    expect(parsed.error.hint).toBeTruthy();
  });

  it("falls back to TOOL_ERROR when no fallback code is given", () => {
    const result = toolErrorResult("just a string");
    const parsed = JSON.parse(result.content[0]!.text) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("TOOL_ERROR");
    expect(parsed.error.message).toBe("just a string");
  });
});
