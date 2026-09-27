// Regression test for a LIMIT 200 escape in the user-defined SQL tools guard
// (ADR-0035 §7/§9: "an enforced LIMIT 200"). wrapSql() splices a tool's SQL
// into `SELECT * FROM (<sql>) LIMIT 200`. A stray unmatched ")" in <sql>
// closes that wrapper's own "(" early; the remainder of <sql> — a "--"
// comment with no following newline — then runs on past the wrapper's real
// ") LIMIT 200" and comments it out, so the statement actually executes with
// whatever LIMIT the author wrote (or none) instead of 200. This runs the
// exploit against real SQLite (via the same createTestDb() harness other
// integration tests use) to prove both that the historical payload really
// did return every row, and that validateSql's paren-balance guard now
// rejects it at definition time before it ever reaches D1.
import { describe, expect, it } from "vitest";
import { D1ItemStore } from "../../src/kernel/d1-item-store";
import { Kernel } from "../../src/kernel/kernel";
import type { ItemInput } from "../../src/kernel/types";
import { D1UserToolStore, ToolGuardError, validateSql, wrapSql } from "../../src/tools/user-tools";
import { createTestDb } from "../support/sqlite-d1";

const EXPLOIT_SQL = "SELECT * FROM v_items) LIMIT 999999999 --";
const SEED_COUNT = 250; // comfortably past the 200-row cap

function seedItems(): ItemInput[] {
  return Array.from({ length: SEED_COUNT }, (_, i) => ({
    id: `item-${i}`,
    source: "test-source",
    kind: "thread",
    title: `Item ${i}`,
    timestamp: new Date().toISOString(),
    url: "https://example.test",
    raw: {},
    facets: [],
  }));
}

describe("user-defined SQL tools — LIMIT 200 cannot be escaped", () => {
  it("define() rejects the exploit payload with SQL_UNBALANCED_PARENS, never reaching D1", async () => {
    const db = await createTestDb();
    const store = new D1UserToolStore(db);
    await expect(
      store.define({ name: "leak_all_items", description: "test", inputSchema: {}, sql: EXPLOIT_SQL }),
    ).rejects.toThrow(ToolGuardError);
    await expect(store.get("leak_all_items")).resolves.toBeNull();
  });

  it("proves the historical bug: the wrapped exploit text, run directly against real SQLite, returns every row instead of 200", async () => {
    const db = await createTestDb();
    await new Kernel(new D1ItemStore(db)).ingest(seedItems());

    // The wrapper this codebase actually ships (wrapSql), fed the raw exploit
    // string — i.e. what would run on every /mcp call if this guard did not exist.
    const wrapped = wrapSql(EXPLOIT_SQL);
    const rows = await db.prepare(wrapped).all();
    expect(rows.results.length).toBe(SEED_COUNT); // > 200: the cap was bypassed.

    // The fix: validateSql refuses to produce a canonical `sql` for this
    // payload at all, so wrapSql() is never called with it in practice.
    expect(() => validateSql(EXPLOIT_SQL, [])).toThrow(ToolGuardError);
  });
});
