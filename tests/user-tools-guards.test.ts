import { describe, expect, it } from "vitest";
import {
  buildZodInputSchema,
  extractParamOrder,
  MAX_SQL_LENGTH,
  RESERVED_DOOR_TOOL_NAMES,
  ToolGuardError,
  validateDescription,
  validateInputSchema,
  validateSql,
  validateToolName,
  wrapSql,
  type ToolError,
} from "../src/tools/user-tools";

// Runs `fn`, expects a ToolGuardError, and returns its structured
// {code, message, hint} for assertions — every guard rejection must carry
// one, per the product's model-facing error contract.
function guardErrorOf(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolGuardError) {
      return error.toolError;
    }
    throw error;
  }
  throw new Error("expected the guard to throw");
}

function ok(sql: string, params: string[] = []) {
  return () => validateSql(sql, params);
}

describe("validateSql — accepts legitimate tools", () => {
  it("accepts a plain SELECT over an allowed view", () => {
    expect(ok("SELECT source, item_id, title FROM v_items WHERE course = :course", ["course"])()).toEqual({
      sql: "SELECT source, item_id, title FROM v_items WHERE course = :course",
      params: ["course"],
    });
  });

  it("accepts WITH ... SELECT with a CTE built only from allowed views", () => {
    const sql = "WITH recent AS (SELECT * FROM v_upcoming) SELECT * FROM recent WHERE course = :course";
    expect(ok(sql, ["course"])()).toEqual({ sql, params: ["course"] });
  });

  it("accepts a CTE with an explicit column list", () => {
    const sql = "WITH recent (bucket, n) AS (SELECT bucket, item_count FROM v_buckets) SELECT * FROM recent";
    expect(() => validateSql(sql, [])).not.toThrow();
  });

  it("accepts joins across two allowed views", () => {
    const sql = "SELECT i.title, c.term FROM v_items i JOIN v_courses c ON i.course = c.code WHERE i.course = :course";
    expect(() => validateSql(sql, ["course"])).not.toThrow();
  });

  it("strips a single trailing semicolon into the canonical SQL", () => {
    expect(validateSql("SELECT * FROM v_items;", []).sql).toBe("SELECT * FROM v_items");
  });

  it("tolerates a leading comment and a trailing comment after the terminator", () => {
    const sql = "-- next lab\nSELECT * FROM v_items; -- done";
    expect(() => validateSql(sql, [])).not.toThrow();
  });

  it("dedupes a repeated named parameter, keeping first-appearance order", () => {
    const sql = "SELECT * FROM v_items WHERE course = :course OR bucket LIKE :course";
    expect(validateSql(sql, ["course"]).params).toEqual(["course"]);
  });

  it("collects distinct params across the statement in order of first use", () => {
    const sql = "SELECT * FROM v_items WHERE course = :course AND bucket = :bucket";
    expect(validateSql(sql, ["course", "bucket"]).params).toEqual(["course", "bucket"]);
  });
});

describe("validateSql — structural guards", () => {
  it("rejects empty SQL", () => {
    expect(guardErrorOf(ok("   ")).code).toBe("SQL_EMPTY");
  });

  it("rejects SQL over the length cap", () => {
    const huge = `SELECT * FROM v_items WHERE title = '${"a".repeat(MAX_SQL_LENGTH)}'`;
    expect(guardErrorOf(ok(huge)).code).toBe("SQL_TOO_LONG");
  });

  it("rejects anything not starting with SELECT or WITH", () => {
    const error = guardErrorOf(ok("EXPLAIN SELECT * FROM v_items"));
    expect(error.code).toBe("SQL_NOT_READ_ONLY");
    expect(error.hint).toMatch(/SELECT/);
  });

  it("rejects two statements separated by a semicolon", () => {
    expect(guardErrorOf(ok("SELECT * FROM v_items; SELECT * FROM v_courses")).code).toBe("SQL_MULTIPLE_STATEMENTS");
  });

  it("rejects a doubled trailing semicolon", () => {
    expect(guardErrorOf(ok("SELECT * FROM v_items;;")).code).toBe("SQL_MULTIPLE_STATEMENTS");
  });

  it("rejects a semicolon that only looks trailing because of an inert comment after it — still one real statement, so this specific case is fine", () => {
    // Sanity check the opposite: a comment AFTER the real trailing ';' must
    // not itself count as content requiring another statement.
    expect(() => validateSql("SELECT * FROM v_items; -- trailing note", [])).not.toThrow();
  });

  it("quotes the offending fragment in the error message", () => {
    const error = guardErrorOf(ok("SELECT * FROM items"));
    expect(error.message).toContain("items");
  });
});

describe("validateSql — parameters", () => {
  it("rejects anonymous ? placeholders", () => {
    expect(guardErrorOf(ok("SELECT * FROM v_items WHERE course = ?")).code).toBe("SQL_POSITIONAL_PARAM");
  });

  it("rejects a named parameter that isn't declared in inputSchema", () => {
    const error = guardErrorOf(ok("SELECT * FROM v_items WHERE course = :course", []));
    expect(error.code).toBe("SQL_UNKNOWN_PARAM");
    expect(error.message).toContain(":course");
    expect(error.hint).toContain("course");
  });
});

describe("validateSql — write/introspection keywords, anywhere outside strings", () => {
  const keywords = ["insert", "update", "delete", "replace", "create", "drop", "alter", "vacuum", "reindex", "attach", "detach", "pragma", "recursive"];

  it.each(keywords)("rejects bare keyword %s used as a column alias", (keyword) => {
    const error = guardErrorOf(ok(`SELECT 1 AS ${keyword} FROM v_items`));
    expect(error.code).toBe("SQL_FORBIDDEN_KEYWORD");
  });

  it("ignores the same words when they only appear inside a string literal", () => {
    const sql = "SELECT * FROM v_items WHERE title = 'please insert; update; delete; drop; --'";
    expect(() => validateSql(sql, [])).not.toThrow();
  });

  it("rejects ATTACH outright (also fails the SELECT/WITH check)", () => {
    expect(guardErrorOf(ok("ATTACH DATABASE 'evil.db' AS eviltarget")).code).toBe("SQL_NOT_READ_ONLY");
  });
});

describe("validateSql — comment smuggling", () => {
  it("rejects a keyword split by a block comment (SEL/**/ECT is two words, neither is SELECT)", () => {
    expect(guardErrorOf(ok("SEL/**/ECT * FROM v_items")).code).toBe("SQL_NOT_READ_ONLY");
  });

  it("a comment between FROM and the table name doesn't hide the table from the guard", () => {
    expect(guardErrorOf(ok("SELECT * FROM/**/items")).code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("a line comment doesn't hide a raw table reference", () => {
    const sql = "SELECT * FROM v_items JOIN items -- widen later\n ON 1 = 1";
    expect(guardErrorOf(ok(sql)).code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("content commented out is genuinely inert, including a semicolon and DROP inside it", () => {
    const sql = "SELECT * FROM v_items /* ; DROP TABLE items; */ WHERE course = :course";
    expect(() => validateSql(sql, ["course"])).not.toThrow();
  });

  it("an unterminated block comment consumes the rest of the input rather than leaking a keyword", () => {
    // No matching "*/": the guard must not treat text after an unterminated
    // block comment as live SQL that happens to omit the closing token.
    expect(() => validateSql("SELECT * FROM v_items /* unterminated", [])).not.toThrow();
  });
});

describe("validateSql — string-literal tricks", () => {
  it("a semicolon and keywords inside a string literal are just data", () => {
    const sql = "SELECT * FROM v_items WHERE title = '); DROP TABLE items; --'";
    expect(() => validateSql(sql, [])).not.toThrow();
  });

  it("handles a doubled single-quote (escaped apostrophe) without ending the string early", () => {
    const sql = "SELECT * FROM v_items WHERE title = 'O''Brien'";
    expect(() => validateSql(sql, [])).not.toThrow();
  });

  it("still rejects a real second statement even if the first ends inside a string boundary", () => {
    const sql = "SELECT * FROM v_items WHERE title = 'x'; DROP TABLE items --'";
    expect(guardErrorOf(ok(sql)).code).toBe("SQL_MULTIPLE_STATEMENTS");
  });
});

describe("validateSql — CTE shadowing a real table name", () => {
  it("rejects a CTE named after an allowed view whose own body reads a raw table", () => {
    const sql = "WITH v_items AS (SELECT * FROM items) SELECT * FROM v_items";
    const error = guardErrorOf(ok(sql));
    expect(error.code).toBe("SQL_FORBIDDEN_TABLE");
    expect(error.message).toContain("items");
  });

  it("rejects a CTE that shadows a raw table name but still can't reach one for its body", () => {
    const sql = "WITH items AS (SELECT * FROM sqlite_master) SELECT * FROM items";
    expect(guardErrorOf(ok(sql)).code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("allows a legitimately-named CTE built only from allowed views", () => {
    const sql = "WITH mine AS (SELECT * FROM v_items) SELECT * FROM mine JOIN v_courses ON 1 = 1";
    expect(() => validateSql(sql, [])).not.toThrow();
  });
});

describe("validateSql — sqlite_master / sqlite_schema", () => {
  it("rejects sqlite_master", () => {
    expect(guardErrorOf(ok("SELECT * FROM sqlite_master")).code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("rejects sqlite_schema (the modern alias)", () => {
    expect(guardErrorOf(ok("SELECT name FROM sqlite_schema")).code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("rejects sqlite_master double-quoted", () => {
    expect(guardErrorOf(ok('SELECT * FROM "sqlite_master"')).code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("rejects any bare identifier starting with sqlite_, even away from FROM/JOIN", () => {
    expect(guardErrorOf(ok("SELECT sqlite_version()")).code).toBe("SQL_FORBIDDEN_TABLE");
  });
});

describe("validateSql — pragma table-valued functions and load_extension", () => {
  it("rejects pragma_table_info() as a FROM target", () => {
    const error = guardErrorOf(ok("SELECT * FROM pragma_table_info('items')"));
    expect(["SQL_FORBIDDEN_FUNCTION", "SQL_TABLE_FUNCTION"]).toContain(error.code);
  });

  it("rejects pragma_table_list()", () => {
    const error = guardErrorOf(ok("SELECT * FROM pragma_table_list()"));
    expect(["SQL_FORBIDDEN_FUNCTION", "SQL_TABLE_FUNCTION"]).toContain(error.code);
  });

  it("rejects a bare PRAGMA statement", () => {
    expect(guardErrorOf(ok("PRAGMA table_info(items)")).code).toBe("SQL_NOT_READ_ONLY");
  });

  it("rejects load_extension anywhere, not just as a FROM target", () => {
    expect(guardErrorOf(ok("SELECT load_extension('evil.so') FROM v_items")).code).toBe("SQL_FORBIDDEN_FUNCTION");
  });
});

describe("validateSql — ATTACH", () => {
  it("rejects ATTACH DATABASE", () => {
    expect(guardErrorOf(ok("ATTACH DATABASE 'file:evil.db' AS evil")).code).toBe("SQL_NOT_READ_ONLY");
  });
});

describe("validateSql — nested subqueries and UNION reaching raw tables", () => {
  it("rejects a raw table reached through a nested IN (subquery)", () => {
    const sql = "SELECT * FROM v_items WHERE item_id IN (SELECT item_id FROM facets)";
    expect(guardErrorOf(ok(sql)).code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("rejects a raw table reached two subqueries deep", () => {
    const sql = "SELECT * FROM v_items WHERE item_id IN (SELECT item_id FROM (SELECT item_id FROM changes))";
    expect(guardErrorOf(ok(sql)).code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("rejects UNION into a raw table", () => {
    const sql = "SELECT source, item_id FROM v_items UNION SELECT source, item_id FROM items";
    expect(guardErrorOf(ok(sql)).code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("allows UNION across two allowed views", () => {
    const sql = "SELECT source, item_id FROM v_items UNION SELECT source, item_id FROM v_upcoming";
    expect(() => validateSql(sql, [])).not.toThrow();
  });
});

describe("validateSql — quoting styles all resolve the same way", () => {
  it.each([
    ['"v_items"', true],
    ["`v_items`", true],
    ["[v_items]", true],
    ['"items"', false],
    ["`items`", false],
    ["[items]", false],
  ])("FROM %s is allowed=%s", (quoted, allowed) => {
    const sql = `SELECT * FROM ${quoted}`;
    if (allowed) {
      expect(() => validateSql(sql, [])).not.toThrow();
    } else {
      expect(guardErrorOf(ok(sql)).code).toBe("SQL_FORBIDDEN_TABLE");
    }
  });

  it("rejects a schema-qualified reference even to an allowed view", () => {
    expect(guardErrorOf(ok("SELECT * FROM main.v_items")).code).toBe("SQL_FORBIDDEN_TABLE");
  });
});

describe("validateSql — case variations", () => {
  it("accepts mixed-case SELECT/FROM and an uppercased view name", () => {
    expect(() => validateSql("SeLeCt * FrOm V_ITEMS", [])).not.toThrow();
  });

  it("rejects a raw table regardless of case", () => {
    expect(guardErrorOf(ok("SeLeCt * FrOm ItEms")).code).toBe("SQL_FORBIDDEN_TABLE");
  });
});

describe("validateSql — unicode lookalikes", () => {
  it("rejects a Cyrillic-і lookalike of v_items (fails closed: it just isn't an allowed name)", () => {
    // U+0456 CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I, not Latin "i".
    const sql = "SELECT * FROM v_іtems";
    expect(guardErrorOf(ok(sql)).code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("a fullwidth lookalike of SELECT is rejected outright, not silently folded into the keyword", () => {
    // U+FF33 FULLWIDTH LATIN CAPITAL LETTER S, etc. Keyword matching stays
    // strict ASCII — normalization is only used to catch lookalike identifiers
    // (above), never to widen what counts as a recognised keyword. That
    // asymmetry is deliberate: it closes the identifier-spoofing hole without
    // opening a keyword-spoofing one.
    const sql = "ＳＥＬＥＣＴ * FROM v_items";
    expect(guardErrorOf(ok(sql)).code).toBe("SQL_NOT_READ_ONLY");
  });
});

describe("validateSql — very long input", () => {
  it("rejects input well past the length cap without hanging", () => {
    const long = `SELECT * FROM v_items WHERE title = '${"x".repeat(50_000)}'`;
    const start = Date.now();
    expect(guardErrorOf(ok(long)).code).toBe("SQL_TOO_LONG");
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("extractParamOrder", () => {
  it("returns distinct params in first-appearance order", () => {
    expect(extractParamOrder("SELECT * FROM v_items WHERE course = :b AND bucket = :a OR course = :b")).toEqual(["b", "a"]);
  });

  it("returns an empty array when there are none", () => {
    expect(extractParamOrder("SELECT * FROM v_items")).toEqual([]);
  });
});

describe("wrapSql", () => {
  it("wraps with the forced row cap", () => {
    expect(wrapSql("SELECT * FROM v_items")).toBe("SELECT * FROM (SELECT * FROM v_items) LIMIT 200");
  });
});

describe("validateToolName", () => {
  it("accepts a valid lowercase name", () => {
    expect(() => validateToolName("next_lab")).not.toThrow();
  });

  it.each(["Next_Lab", "1lab", "ab", "a".repeat(41), "next-lab", "next lab"])("rejects invalid name %s", (name) => {
    expect(guardErrorOf(() => validateToolName(name)).code).toBe("TOOL_INVALID_NAME");
  });

  it("rejects a name colliding with a built-in door tool", () => {
    expect(guardErrorOf(() => validateToolName("status")).code).toBe("TOOL_NAME_RESERVED");
  });

  it("respects a custom reserved set", () => {
    expect(() => validateToolName("status", new Set())).not.toThrow();
    expect(RESERVED_DOOR_TOOL_NAMES.has("get_briefs")).toBe(true);
  });
});

describe("validateDescription", () => {
  it("rejects empty description", () => {
    expect(guardErrorOf(() => validateDescription("   ")).code).toBe("TOOL_DESCRIPTION_EMPTY");
  });

  it("rejects a description over the cap", () => {
    expect(guardErrorOf(() => validateDescription("x".repeat(501))).code).toBe("TOOL_DESCRIPTION_TOO_LONG");
  });

  it("accepts a normal description", () => {
    expect(() => validateDescription("Labs due in the next 7 days.")).not.toThrow();
  });
});

describe("validateInputSchema", () => {
  it("returns declared param names", () => {
    expect(validateInputSchema({ course: { type: "string" }, days: { type: "integer" } })).toEqual(["course", "days"]);
  });

  it("rejects more than 10 params", () => {
    const schema = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${i}`, { type: "string" as const }]));
    expect(guardErrorOf(() => validateInputSchema(schema)).code).toBe("TOOL_TOO_MANY_PARAMS");
  });

  it("rejects an invalid param name", () => {
    expect(guardErrorOf(() => validateInputSchema({ "Bad-Name": { type: "string" } })).code).toBe("TOOL_INVALID_PARAM_NAME");
  });

  it("rejects an unknown param type", () => {
    expect(guardErrorOf(() => validateInputSchema({ course: { type: "array" as never } })).code).toBe("TOOL_INVALID_PARAM_TYPE");
  });
});

describe("buildZodInputSchema", () => {
  it("builds a string field and parses a value", () => {
    const shape = buildZodInputSchema({ course: { type: "string" } });
    expect(shape.course!.parse("FIT2004")).toBe("FIT2004");
  });

  it("builds an optional field with a default when default is set", () => {
    const shape = buildZodInputSchema({ days: { type: "integer", default: 7 } });
    expect(shape.days!.parse(undefined)).toBe(7);
  });

  it("builds an enum field from string values", () => {
    const shape = buildZodInputSchema({ state: { type: "string", enum: ["open", "closed"] } });
    expect(shape.state!.parse("open")).toBe("open");
    expect(() => shape.state!.parse("bogus")).toThrow();
  });

  it("builds a boolean field", () => {
    const shape = buildZodInputSchema({ includeOverdue: { type: "boolean" } });
    expect(shape.includeOverdue!.parse(true)).toBe(true);
  });
});
