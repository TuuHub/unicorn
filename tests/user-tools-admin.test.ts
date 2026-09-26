import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearLibraryCache } from "../src/tools/library";
import { createAdminMcpServer, type McpRepository } from "../src/mcp/server";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  clearLibraryCache();
  vi.unstubAllGlobals();
});

interface Row {
  name: string;
  description: string;
  input_schema_json: string;
  sql: string;
  created_at: string;
  updated_at: string;
}

// One in-memory user_tools table, plus a fixed set of PRAGMA/example-row
// answers for describe_schema and a settings row for resolveToolsRepo — the
// full surface the seven ADR-0035 admin tools touch.
function fakeD1(options: { settingsRow?: { value_json: string } } = {}) {
  const table: Row[] = [];
  const now = () => "2026-09-26T00:00:00.000Z";

  function statement(sql: string, boundValues: unknown[]) {
    return {
      bind: (...values: unknown[]) => statement(sql, values),
      all: async () => {
        if (sql.startsWith("EXPLAIN")) {
          return { results: [] };
        }
        if (sql.startsWith("PRAGMA table_info")) {
          return { results: [{ name: "source" }, { name: "item_id" }, { name: "title" }] };
        }
        if (sql.includes("SELECT * FROM user_tools ORDER BY name")) {
          return { results: [...table] };
        }
        return { results: [] };
      },
      first: async () => {
        if (sql.startsWith("SELECT * FROM v_")) {
          return { source: "campus-moodle", item_id: "1", title: "example" };
        }
        if (sql.includes("SELECT COUNT(*) AS n FROM user_tools")) {
          return { n: table.length };
        }
        if (sql.includes("SELECT * FROM user_tools WHERE name = ?")) {
          return table.find((row) => row.name === boundValues[0]) ?? null;
        }
        if (sql.includes("SELECT value_json FROM settings WHERE key = 'tools_repo'")) {
          return options.settingsRow ?? null;
        }
        return null;
      },
      run: async () => {
        if (sql.startsWith("DELETE FROM user_tools")) {
          const index = table.findIndex((row) => row.name === boundValues[0]);
          if (index === -1) return { meta: { changes: 0 } };
          table.splice(index, 1);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO user_tools")) {
          const [name, description, inputSchemaJson, toolSql, createdAt, updatedAt] = boundValues as string[];
          const index = table.findIndex((row) => row.name === name);
          const row: Row = { name, description, input_schema_json: inputSchemaJson, sql: toolSql, created_at: createdAt, updated_at: updatedAt };
          if (index === -1) table.push(row);
          else table[index] = row;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }

  return { db: { prepare: (sql: string) => statement(sql, []) } as unknown as D1Database, table, now };
}

async function connectClient(db: D1Database, repository: Partial<McpRepository> = {}): Promise<Client> {
  const server = createAdminMcpServer(repository as McpRepository, { db });
  const client = new Client({ name: "user-tools-admin-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function jsonOf(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "null");
}

describe("admin MCP server — ADR-0035 user-tool tools", () => {
  it("exposes the seven user-tool admin tools alongside the existing ones", async () => {
    const { db } = fakeD1();
    const client = await connectClient(db);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const name of ["describe_schema", "define_tool", "list_tools", "delete_tool", "browse_tools", "install_tool", "publish_tool"]) {
      expect(names).toContain(name);
    }
  });

  it("describe_schema returns columns and an example row for all five views", async () => {
    const { db } = fakeD1();
    const client = await connectClient(db);

    const result = await client.callTool({ name: "describe_schema", arguments: {} });

    const schema = jsonOf(result) as Record<string, { columns: string[]; example: unknown }>;
    expect(Object.keys(schema).sort()).toEqual(["v_buckets", "v_changes", "v_courses", "v_items", "v_upcoming"]);
    expect(schema.v_items!.columns).toEqual(["source", "item_id", "title"]);
    expect(schema.v_items!.example).toEqual({ source: "campus-moodle", item_id: "1", title: "example" });
  });

  it("define_tool stores a valid tool and list_tools then returns it", async () => {
    const { db } = fakeD1();
    const client = await connectClient(db);

    const defineResult = await client.callTool({
      name: "define_tool",
      arguments: { name: "next_lab", description: "Labs due soon.", inputSchema: {}, sql: "SELECT * FROM v_upcoming" },
    });
    expect(defineResult.isError).toBeFalsy();
    expect((jsonOf(defineResult) as { tool: { name: string } }).tool.name).toBe("next_lab");

    const listResult = await client.callTool({ name: "list_tools", arguments: {} });
    expect((jsonOf(listResult) as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(["next_lab"]);
  });

  it("define_tool rejects a guard failure with a structured, quoted error", async () => {
    const { db } = fakeD1();
    const client = await connectClient(db);

    const result = await client.callTool({
      name: "define_tool",
      arguments: { name: "sneaky", description: "d", inputSchema: {}, sql: "SELECT * FROM items" },
    });

    expect(result.isError).toBe(true);
    const parsed = jsonOf(result) as { error: { code: string; message: string; hint: string } };
    expect(parsed.error.code).toBe("SQL_FORBIDDEN_TABLE");
    expect(parsed.error.message).toContain("items");
    expect(parsed.error.hint).toBeTruthy();
  });

  it("delete_tool removes a defined tool", async () => {
    const { db } = fakeD1();
    const client = await connectClient(db);
    await client.callTool({ name: "define_tool", arguments: { name: "next_lab", description: "d", inputSchema: {}, sql: "SELECT * FROM v_upcoming" } });

    const result = await client.callTool({ name: "delete_tool", arguments: { name: "next_lab" } });

    expect(jsonOf(result)).toEqual({ deleted: true });
    const list = await client.callTool({ name: "list_tools", arguments: {} });
    expect((jsonOf(list) as { tools: unknown[] }).tools).toEqual([]);
  });

  it("browse_tools fetches the resolved repo's index.json through the injected fetch", async () => {
    const { db } = fakeD1({ settingsRow: { value_json: JSON.stringify({ repo: "someone/tools" }) } });
    const client = await connectClient(db);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tools: [{ name: "next_lab", description: "d", path: "tools/next_lab.json" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.callTool({ name: "browse_tools", arguments: {} });

    expect(fetchMock).toHaveBeenCalledWith("https://raw.githubusercontent.com/someone/tools/main/index.json");
    expect(jsonOf(result)).toMatchObject({ repo: "someone/tools", tools: [{ name: "next_lab" }] });
  });

  it("browse_tools reports a fetch failure as a structured error, not a thrown exception", async () => {
    const { db } = fakeD1();
    const client = await connectClient(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));

    const result = await client.callTool({ name: "browse_tools", arguments: {} });

    expect(result.isError).toBe(true);
    expect((jsonOf(result) as { error: { code: string } }).error.code).toBe("BROWSE_TOOLS_FAILED");
  });

  it("install_tool fetches the named tool and defines it through the same guard", async () => {
    const { db } = fakeD1();
    const client = await connectClient(db);
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("index.json")) {
        return new Response(JSON.stringify({ tools: [{ name: "next_lab", description: "d", path: "tools/next_lab.json" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: "next_lab", description: "Labs due soon.", inputSchema: {}, sql: "SELECT * FROM v_upcoming" }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.callTool({ name: "install_tool", arguments: { name: "next_lab" } });

    expect(result.isError).toBeFalsy();
    expect((jsonOf(result) as { tool: { name: string } }).tool.name).toBe("next_lab");
  });

  it("install_tool surfaces an unknown library name as a structured error", async () => {
    const { db } = fakeD1();
    const client = await connectClient(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ tools: [] }), { status: 200 })));

    const result = await client.callTool({ name: "install_tool", arguments: { name: "does_not_exist" } });

    expect(result.isError).toBe(true);
    expect((jsonOf(result) as { error: { code: string; message: string } }).error.message).toContain("does_not_exist");
  });

  it("publish_tool returns a PR-ready payload for a defined tool", async () => {
    const { db } = fakeD1();
    const client = await connectClient(db);
    await client.callTool({ name: "define_tool", arguments: { name: "next_lab", description: "Labs due soon.", inputSchema: {}, sql: "SELECT * FROM v_upcoming" } });

    const result = await client.callTool({ name: "publish_tool", arguments: { name: "next_lab" } });

    const payload = jsonOf(result) as { path: string; ghCommands: string[] };
    expect(payload.path).toBe("tools/next_lab.json");
    expect(payload.ghCommands.some((cmd) => cmd.includes("gh pr create"))).toBe(true);
  });

  it("publish_tool 404s a name that was never defined", async () => {
    const { db } = fakeD1();
    const client = await connectClient(db);

    const result = await client.callTool({ name: "publish_tool", arguments: { name: "ghost" } });

    expect(result.isError).toBe(true);
    expect((jsonOf(result) as { error: { code: string } }).error.code).toBe("TOOL_NOT_FOUND");
  });
});
