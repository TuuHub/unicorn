import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browseTools,
  buildPublishPayload,
  clearLibraryCache,
  DEFAULT_TOOLS_REPO,
  fetchLibraryTool,
  installTool,
  resolveToolsRepo,
  type Fetcher,
} from "../src/tools/library";
import type { UserToolDefinition } from "../src/tools/user-tools";

afterEach(() => {
  clearLibraryCache();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetcher(routes: Record<string, unknown>): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url: string) => {
    calls.push(url);
    const body = routes[url];
    if (body === undefined) {
      return new Response("not found", { status: 404 });
    }
    return jsonResponse(body);
  };
  return { fetcher, calls };
}

describe("browseTools", () => {
  it("fetches the repo's index.json", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/index.json": { tools: [{ name: "next_lab", description: "d", path: "tools/next_lab.json" }] },
    });

    const index = await browseTools(DEFAULT_TOOLS_REPO, fetcher);

    expect(index.tools).toEqual([{ name: "next_lab", description: "d", path: "tools/next_lab.json" }]);
    expect(calls).toEqual(["https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/index.json"]);
  });

  it("filters by a case-insensitive substring match on name or description", async () => {
    const { fetcher } = fakeFetcher({
      "https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/index.json": {
        tools: [
          { name: "next_lab", description: "Labs due soon.", path: "tools/next_lab.json" },
          { name: "overdue", description: "Missed deadlines.", path: "tools/overdue.json" },
        ],
      },
    });

    const filtered = await browseTools(DEFAULT_TOOLS_REPO, fetcher, "LAB");

    expect(filtered.tools.map((t) => t.name)).toEqual(["next_lab"]);
  });

  it("caches the index and does not re-fetch within the TTL for the same repo", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/index.json": { tools: [] },
    });

    await browseTools(DEFAULT_TOOLS_REPO, fetcher);
    await browseTools(DEFAULT_TOOLS_REPO, fetcher);

    expect(calls.length).toBe(1);
  });

  it("re-fetches when the repo changes even with a warm cache", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/index.json": { tools: [] },
      "https://raw.githubusercontent.com/someone/tools/main/index.json": { tools: [] },
    });

    await browseTools(DEFAULT_TOOLS_REPO, fetcher);
    await browseTools("someone/tools", fetcher);

    expect(calls.length).toBe(2);
  });

  it("clearLibraryCache forces a fresh fetch", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/index.json": { tools: [] },
    });

    await browseTools(DEFAULT_TOOLS_REPO, fetcher);
    clearLibraryCache();
    await browseTools(DEFAULT_TOOLS_REPO, fetcher);

    expect(calls.length).toBe(2);
  });

  it("raises a descriptive error on a non-OK response", async () => {
    const { fetcher } = fakeFetcher({});
    await expect(browseTools(DEFAULT_TOOLS_REPO, fetcher)).rejects.toThrow(/404/);
  });
});

describe("fetchLibraryTool", () => {
  it("fetches the tool file at the entry's path", async () => {
    const file = { name: "next_lab", description: "d", inputSchema: {}, sql: "SELECT * FROM v_upcoming" };
    const { fetcher, calls } = fakeFetcher({ "https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/tools/next_lab.json": file });

    const result = await fetchLibraryTool(DEFAULT_TOOLS_REPO, { name: "next_lab", description: "d", path: "tools/next_lab.json" }, fetcher);

    expect(result).toEqual(file);
    expect(calls).toEqual(["https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/tools/next_lab.json"]);
  });
});

describe("installTool", () => {
  it("looks the name up in the index, fetches its file, and calls define with it", async () => {
    const file = { name: "next_lab", description: "Labs due soon.", inputSchema: { days: { type: "integer" as const } }, sql: "SELECT * FROM v_upcoming" };
    const { fetcher } = fakeFetcher({
      "https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/index.json": { tools: [{ name: "next_lab", description: "d", path: "tools/next_lab.json" }] },
      "https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/tools/next_lab.json": file,
    });
    const define = vi.fn().mockResolvedValue({ ...file, createdAt: "x", updatedAt: "x" } satisfies UserToolDefinition);

    const result = await installTool(DEFAULT_TOOLS_REPO, "next_lab", define, fetcher);

    expect(define).toHaveBeenCalledWith({ name: "next_lab", description: "Labs due soon.", inputSchema: file.inputSchema, sql: file.sql });
    expect(result.name).toBe("next_lab");
  });

  it("rejects a name that isn't in the index, without calling define", async () => {
    const { fetcher } = fakeFetcher({
      "https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/index.json": { tools: [] },
    });
    const define = vi.fn();

    await expect(installTool(DEFAULT_TOOLS_REPO, "ghost", define, fetcher)).rejects.toThrow(/ghost/);
    expect(define).not.toHaveBeenCalled();
  });

  it("propagates a guard rejection from define unchanged", async () => {
    const { fetcher } = fakeFetcher({
      "https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/index.json": { tools: [{ name: "sneaky", description: "d", path: "tools/sneaky.json" }] },
      "https://raw.githubusercontent.com/TuuHub/unicorn-tools/main/tools/sneaky.json": { name: "sneaky", description: "d", inputSchema: {}, sql: "SELECT * FROM items" },
    });
    const define = vi.fn().mockRejectedValue(new Error("guard: SQL_FORBIDDEN_TABLE"));

    await expect(installTool(DEFAULT_TOOLS_REPO, "sneaky", define, fetcher)).rejects.toThrow(/SQL_FORBIDDEN_TABLE/);
  });
});

describe("resolveToolsRepo", () => {
  function fakeDb(row: { value_json: string } | null): D1Database {
    return {
      prepare: () => ({
        bind: () => ({ first: async () => row }),
        first: async () => row,
      }),
    } as unknown as D1Database;
  }

  it("returns the default repo when no setting is stored", async () => {
    expect(await resolveToolsRepo(fakeDb(null))).toBe(DEFAULT_TOOLS_REPO);
  });

  it("returns the stored repo when set", async () => {
    expect(await resolveToolsRepo(fakeDb({ value_json: JSON.stringify({ repo: "someone/tools" }) }))).toBe("someone/tools");
  });

  it("falls back to the default on malformed JSON", async () => {
    expect(await resolveToolsRepo(fakeDb({ value_json: "not json" }))).toBe(DEFAULT_TOOLS_REPO);
  });

  it("falls back to the default when the stored value has no repo field", async () => {
    expect(await resolveToolsRepo(fakeDb({ value_json: JSON.stringify({ other: 1 }) }))).toBe(DEFAULT_TOOLS_REPO);
  });

  it("falls back to the default on a blank repo string", async () => {
    expect(await resolveToolsRepo(fakeDb({ value_json: JSON.stringify({ repo: "   " }) }))).toBe(DEFAULT_TOOLS_REPO);
  });
});

describe("buildPublishPayload", () => {
  const tool: UserToolDefinition = {
    name: "next_lab",
    description: "Labs due soon.",
    inputSchema: { days: { type: "integer", default: 7 } },
    sql: "SELECT title FROM v_upcoming",
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
  };

  it("writes the tool file under tools/<name>.json with the definition fields only", () => {
    const payload = buildPublishPayload(DEFAULT_TOOLS_REPO, tool);

    expect(payload.path).toBe("tools/next_lab.json");
    expect(JSON.parse(payload.content)).toEqual({ name: "next_lab", description: "Labs due soon.", inputSchema: tool.inputSchema, sql: tool.sql });
  });

  it("builds a matching index.json entry", () => {
    const payload = buildPublishPayload(DEFAULT_TOOLS_REPO, tool);

    expect(payload.indexEntry).toEqual({ name: "next_lab", description: "Labs due soon.", path: "tools/next_lab.json" });
  });

  it("never includes a github-writing command the Worker itself would run", () => {
    const payload = buildPublishPayload(DEFAULT_TOOLS_REPO, tool);

    expect(payload.ghCommands.join("\n")).toContain(`git clone https://github.com/${DEFAULT_TOOLS_REPO}.git`);
    expect(payload.ghCommands.some((cmd) => cmd.startsWith("gh pr create"))).toBe(true);
  });
});
