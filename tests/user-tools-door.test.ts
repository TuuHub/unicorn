import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerUserTools } from "../src/tools/user-tools";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

interface StoredToolRow {
  name: string;
  description: string;
  input_schema_json: string;
  sql: string;
  created_at: string;
  updated_at: string;
}

// registerUserTools only ever calls store.list() (to build the tool set) and,
// per call, the wrapped SELECT — so the fake only needs to answer those two
// query shapes.
function fakeDb(rows: StoredToolRow[], queryResults: Record<string, unknown[]>) {
  function statement(sql: string, values: unknown[]) {
    return {
      bind: (...boundValues: unknown[]) => statement(sql, boundValues),
      all: async () => {
        if (sql.includes("FROM user_tools")) {
          return { results: rows };
        }
        for (const [marker, results] of Object.entries(queryResults)) {
          if (sql.includes(marker)) {
            if (results instanceof Error) throw results;
            return { results };
          }
        }
        throw new Error(`fakeDb: no route for ${sql}`);
      },
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
    };
  }
  return { prepare: (sql: string) => statement(sql, []) } as unknown as D1Database;
}

function row(overrides: Partial<StoredToolRow>): StoredToolRow {
  return {
    name: "next_lab",
    description: "Labs due soon.",
    input_schema_json: JSON.stringify({ course: { type: "string" } }),
    sql: "SELECT title, course FROM v_items WHERE course = :course",
    created_at: "2026-09-26T00:00:00.000Z",
    updated_at: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

async function connectClient(db: D1Database): Promise<Client> {
  const server = new McpServer({ name: "test-door", version: "0.0.0" });
  await registerUserTools(server, { db });
  const client = new Client({ name: "user-tools-door-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((entry) => entry.type === "text")?.text ?? "";
}

describe("registerUserTools", () => {
  it("registers every stored tool by name, with its stored description", async () => {
    const db = fakeDb([row({ name: "next_lab" }), row({ name: "week_ahead", description: "This week's items." })], {});
    const client = await connectClient(db);

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(["next_lab", "week_ahead"]);
    expect(tools.find((t) => t.name === "week_ahead")?.description).toBe("This week's items.");
  });

  it("defensively skips a stored row whose name collides with a reserved door tool", async () => {
    const db = fakeDb([row({ name: "status" }), row({ name: "next_lab" })], {});
    const client = await connectClient(db);

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(["next_lab"]);
  });

  it("executes the stored SQL with bound args and renders a table", async () => {
    const db = fakeDb([row({ sql: "SELECT title, course FROM v_items WHERE course = :course" })], {
      "FROM v_items": [{ title: "Lab report 4", course: "FIT2004" }],
    });
    const client = await connectClient(db);

    const result = await client.callTool({ name: "next_lab", arguments: { course: "FIT2004" } });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Lab report 4");
    expect((result.structuredContent as { rows: unknown[] }).rows).toEqual([{ title: "Lab report 4", course: "FIT2004" }]);
  });

  it("binds params in the SQL's first-appearance order, not the object's key order", async () => {
    const bound: unknown[][] = [];
    const db: D1Database = {
      prepare: (sql: string) => {
        const capture = (values: unknown[]) => {
          const stmt = {
            bind: (...values2: unknown[]) => capture(values2),
            all: async () => {
              if (sql.includes("FROM user_tools")) {
                return {
                  results: [
                    row({
                      sql: "SELECT * FROM v_items WHERE bucket = :bucket AND course = :course",
                      input_schema_json: JSON.stringify({ bucket: { type: "string" }, course: { type: "string" } }),
                    }),
                  ],
                };
              }
              bound.push(values);
              return { results: [] };
            },
            first: async () => null,
            run: async () => ({ meta: { changes: 0 } }),
          };
          return stmt;
        };
        return capture([]);
      },
    } as unknown as D1Database;
    const client = await connectClient(db);

    await client.callTool({ name: "next_lab", arguments: { course: "FIT2004", bucket: "course/FIT2004/general" } });

    expect(bound).toEqual([["course/FIT2004/general", "FIT2004"]]);
  });

  it("returns a structured tool-execution error instead of throwing when the query fails at call time", async () => {
    const db = fakeDb([row({})], { "FROM v_items": new Error("D1_ERROR: no such column: bogus") as unknown as unknown[] });
    const client = await connectClient(db);

    const result = await client.callTool({ name: "next_lab", arguments: { course: "FIT2004" } });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result)) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("TOOL_EXECUTION_FAILED");
    expect(parsed.error.message).toContain("no such column");
  });

  it("advertises no tools capability at all when none are stored", async () => {
    const db = fakeDb([], {});
    const client = await connectClient(db);

    // The MCP SDK only advertises the tools capability once registerTool has
    // been called at least once — with zero stored rows, tools/list itself
    // isn't a method the server supports, which is the correct "no tools" shape.
    await expect(client.listTools()).rejects.toThrow(/Method not found/);
  });
});
