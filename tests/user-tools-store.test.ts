import { describe, expect, it, vi } from "vitest";
import { D1UserToolStore, MAX_TOOLS, ToolGuardError, type ToolError } from "../src/tools/user-tools";

// A tiny, genuinely stateful in-memory D1 fake — the store's define() reads
// its own prior writes (existing-row lookup, the COUNT(*) cap check, the
// upsert itself), so a stateless substring-routed fixture (as used for
// read-only repositories elsewhere in this suite) can't exercise it.
// EXPLAIN succeeds for everything except a SQL string containing the
// sentinel below, simulating SQLite rejecting a statement at definition time.
const EXPLAIN_FAILS_MARKER = "__force_explain_failure__";

interface Row {
  name: string;
  description: string;
  input_schema_json: string;
  sql: string;
  created_at: string;
  updated_at: string;
}

function fakeD1() {
  const table: Row[] = [];

  function statement(sql: string, boundValues: unknown[]) {
    return {
      bind: (...values: unknown[]) => statement(sql, values),
      all: async () => {
        if (sql.startsWith("EXPLAIN")) {
          if (sql.includes(EXPLAIN_FAILS_MARKER)) {
            throw new Error("no such column: bogus");
          }
          return { results: [] };
        }
        if (sql.includes("SELECT * FROM user_tools ORDER BY name")) {
          return { results: [...table].sort((a, b) => a.name.localeCompare(b.name)) };
        }
        return { results: [] };
      },
      first: async () => {
        if (sql.includes("SELECT COUNT(*) AS n FROM user_tools")) {
          return { n: table.length };
        }
        if (sql.includes("SELECT * FROM user_tools WHERE name = ?")) {
          return table.find((row) => row.name === boundValues[0]) ?? null;
        }
        return null;
      },
      run: async () => {
        if (sql.startsWith("DELETE FROM user_tools")) {
          const index = table.findIndex((row) => row.name === boundValues[0]);
          if (index === -1) {
            return { meta: { changes: 0 } };
          }
          table.splice(index, 1);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO user_tools")) {
          const [name, description, inputSchemaJson, toolSql, createdAt, updatedAt] = boundValues as string[];
          const index = table.findIndex((row) => row.name === name);
          const row: Row = { name, description, input_schema_json: inputSchemaJson, sql: toolSql, created_at: createdAt, updated_at: updatedAt };
          if (index === -1) {
            table.push(row);
          } else {
            table[index] = row;
          }
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }

  const prepare = vi.fn((sql: string) => statement(sql, []));
  return { db: { prepare } as unknown as D1Database, table };
}

const NOW = () => new Date("2026-09-26T00:00:00.000Z");

function guardErrorOf(fn: () => Promise<unknown>): Promise<ToolError> {
  return fn().then(
    () => {
      throw new Error("expected the call to reject");
    },
    (error: unknown) => {
      if (error instanceof ToolGuardError) return error.toolError;
      throw error;
    },
  );
}

describe("D1UserToolStore.define", () => {
  it("stores a new tool and proves its SQL with EXPLAIN first", async () => {
    const { db } = fakeD1();
    const store = new D1UserToolStore(db, NOW);

    const tool = await store.define({
      name: "next_lab",
      description: "Labs due soon.",
      inputSchema: { days: { type: "integer", default: 7 } },
      sql: "SELECT title, due_at FROM v_upcoming WHERE due_at <= datetime('now', '+' || :days || ' days')",
    });

    expect(tool.name).toBe("next_lab");
    expect(tool.createdAt).toBe("2026-09-26T00:00:00.000Z");
    expect(tool.updatedAt).toBe("2026-09-26T00:00:00.000Z");
  });

  it("round-trips through list() and get()", async () => {
    const { db } = fakeD1();
    const store = new D1UserToolStore(db, NOW);
    await store.define({ name: "overdue", description: "Overdue items.", inputSchema: {}, sql: "SELECT * FROM v_upcoming" });

    expect((await store.list()).map((t) => t.name)).toEqual(["overdue"]);
    expect(await store.get("overdue")).not.toBeNull();
    expect(await store.get("missing")).toBeNull();
  });

  it("upserts on a repeat name, keeping the original createdAt", async () => {
    const { db } = fakeD1();
    let now = new Date("2026-09-26T00:00:00.000Z");
    const store = new D1UserToolStore(db, () => now);

    const first = await store.define({ name: "overdue", description: "v1", inputSchema: {}, sql: "SELECT * FROM v_upcoming" });
    now = new Date("2026-09-27T00:00:00.000Z");
    const second = await store.define({ name: "overdue", description: "v2", inputSchema: {}, sql: "SELECT * FROM v_items" });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe("2026-09-27T00:00:00.000Z");
    expect(second.description).toBe("v2");
    expect((await store.list()).length).toBe(1);
  });

  it("deletes by name and reports whether a row existed", async () => {
    const { db } = fakeD1();
    const store = new D1UserToolStore(db, NOW);
    await store.define({ name: "overdue", description: "d", inputSchema: {}, sql: "SELECT * FROM v_upcoming" });

    expect(await store.delete("overdue")).toBe(true);
    expect(await store.delete("overdue")).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("enforces the cap on a genuinely new tool, but not on updating an existing one", async () => {
    const { db, table } = fakeD1();
    const store = new D1UserToolStore(db, NOW);
    for (let i = 0; i < MAX_TOOLS; i += 1) {
      table.push({
        name: `tool_${i}`,
        description: "d",
        input_schema_json: "{}",
        sql: "SELECT * FROM v_items",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
    }

    const error = await guardErrorOf(() => store.define({ name: "one_too_many", description: "d", inputSchema: {}, sql: "SELECT * FROM v_items" }));
    expect(error.code).toBe("TOOL_CAP_REACHED");

    // Updating an existing tool at the cap must still work — it's not a new row.
    await expect(store.define({ name: "tool_0", description: "updated", inputSchema: {}, sql: "SELECT * FROM v_items" })).resolves.toMatchObject({
      description: "updated",
    });
  });

  it("rejects a name colliding with a built-in door tool before ever touching D1", async () => {
    const { db } = fakeD1();
    const store = new D1UserToolStore(db, NOW);
    const error = await guardErrorOf(() => store.define({ name: "status", description: "d", inputSchema: {}, sql: "SELECT * FROM v_items" }));
    expect(error.code).toBe("TOOL_NAME_RESERVED");
  });

  it("rejects SQL that reaches a raw table before ever calling EXPLAIN", async () => {
    const { db } = fakeD1();
    const store = new D1UserToolStore(db, NOW);
    const error = await guardErrorOf(() => store.define({ name: "sneaky", description: "d", inputSchema: {}, sql: "SELECT * FROM items" }));
    expect(error.code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("surfaces a real EXPLAIN failure as SQL_EXPLAIN_FAILED, quoting the statement", async () => {
    const { db } = fakeD1();
    const store = new D1UserToolStore(db, NOW);
    // The guard has no schema knowledge, so a syntactically-fine query against
    // a nonexistent column passes it and only fails at EXPLAIN time — this is
    // exactly the case EXPLAIN-before-store exists to catch.
    const error = await guardErrorOf(() =>
      store.define({ name: "bad_column", description: "d", inputSchema: {}, sql: `SELECT ${EXPLAIN_FAILS_MARKER} FROM v_items` }),
    );
    expect(error.code).toBe("SQL_EXPLAIN_FAILED");
    expect(error.message).toContain(EXPLAIN_FAILS_MARKER);
  });

  it("never stores a tool whose EXPLAIN failed", async () => {
    const { db } = fakeD1();
    const store = new D1UserToolStore(db, NOW);
    await guardErrorOf(() => store.define({ name: "bad_column", description: "d", inputSchema: {}, sql: `SELECT ${EXPLAIN_FAILS_MARKER} FROM v_items` })).catch(
      () => {},
    );
    expect(await store.get("bad_column")).toBeNull();
  });
});
