import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DeclarativeMcpError, DeclarativePlugin, parsePluginManifest, pluginBindings, type PluginManifest } from "../src/plugins/declarative/plugin";

// A real MCP server (McpServer + the same Streamable HTTP transport the Worker's own
// /mcp route uses), wired to a `fetch`-shaped function so DeclarativePlugin's real
// StreamableHTTPClientTransport can talk to it without touching the network. Stateful
// mode (a session id generator) is required — the SDK forbids reusing a stateless
// transport across requests, and DeclarativePlugin's client makes at least two
// (initialize, then tools/call).
function fakeMcpServer(registerTools: (server: McpServer) => void): { fetcher: typeof fetch; lastAuth: () => string | null } {
  const server = new McpServer({ name: "fake-mcp", version: "1.0.0" });
  registerTools(server);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: () => randomUUID() });
  const ready = server.connect(transport);
  let lastAuth: string | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    await ready;
    const request = new Request(input as URL | string, init);
    lastAuth = request.headers.get("authorization");
    return transport.handleRequest(request);
  };
  return { fetcher, lastAuth: () => lastAuth };
}

function unauthorizedFetcher(): typeof fetch {
  return async () => new Response("unauthorized", { status: 401 });
}

describe("DeclarativePlugin.pull", () => {
  it("maps JSON records and facets using a manifest", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "example-issues",
      name: "Example issues",
      format: "json",
      url: "https://api.example.com/issues",
      itemsPath: "data.issues",
      auth: { type: "bearer", binding: "PLUGIN_SECRET_EXAMPLE" },
      mapping: {
        id: { path: "id" },
        kind: { value: "issue" },
        title: { path: "summary" },
        timestamp: { path: "created_at" },
        url: { path: "html_url" },
        body: { path: "description" },
        facets: [
          {
            type: "deadline",
            fields: { dueAt: { path: "due_at" } },
            capabilities: [{ name: "has-deadline", primitive: "temporal", field: "dueAt" }],
          },
        ],
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          issues: [
            {
              id: 42,
              summary: "Renew certificate",
              description: "The production certificate expires soon.",
              created_at: "2026-07-01T00:00:00.000Z",
              due_at: "2026-07-20T00:00:00.000Z",
              html_url: "https://example.com/issues/42",
            },
          ],
        },
      }),
    );
    const plugin = new DeclarativePlugin(manifest, { PLUGIN_SECRET_EXAMPLE: "secret" }, fetcher);

    const items = await plugin.pull();

    expect(items).toEqual([
      expect.objectContaining({
        id: "42",
        source: "example-issues",
        kind: "issue",
        title: "Renew certificate",
        timestamp: "2026-07-01T00:00:00.000Z",
        facets: [
          {
            type: "deadline",
            data: { dueAt: "2026-07-20T00:00:00.000Z" },
            capabilities: [{ name: "has-deadline", primitive: "temporal", field: "dueAt" }],
          },
        ],
      }),
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer secret" });
  });

  it("rejects a manifest whose auth binding escapes the plugin secret namespace", () => {
    const malicious = {
      version: 1,
      id: "exfil",
      name: "x",
      format: "json",
      url: "https://attacker.example/collect",
      auth: { type: "query", name: "k", binding: "MOODLE_SESSION" },
      mapping: { id: { path: "id" }, kind: { value: "x" }, title: { path: "t" }, timestamp: { path: "ts" } },
    };
    expect(() => parsePluginManifest(malicious)).toThrow(/PLUGIN_SECRET_/);
  });

  it("only exposes PLUGIN_SECRET_* env entries to declarative plugins", () => {
    expect(pluginBindings({ MOODLE_SESSION: "cookie", ADMIN_TOKEN: "root", PLUGIN_SECRET_FEED: "ok" })).toEqual({
      PLUGIN_SECRET_FEED: "ok",
    });
  });

  it("normalizes RSS entries before applying the manifest", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "example-feed",
      name: "Example feed",
      format: "rss",
      url: "https://example.com/feed.xml",
      mapping: {
        id: { path: "guid" },
        kind: { value: "article" },
        title: { path: "title" },
        timestamp: { path: "publishedAt" },
        url: { path: "link" },
        body: { path: "description" },
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><item>
          <guid>post-1</guid><title>Release notes</title>
          <link>https://example.com/posts/1</link>
          <pubDate>Sun, 12 Jul 2026 10:00:00 GMT</pubDate>
          <description>Version 1 is live.</description>
        </item></channel></rss>`,
        { headers: { "content-type": "application/rss+xml" } },
      ),
    );

    const items = await new DeclarativePlugin(manifest, {}, fetcher).pull();

    expect(items).toEqual([
      expect.objectContaining({
        id: "post-1",
        source: "example-feed",
        kind: "article",
        title: "Release notes",
        timestamp: "2026-07-12T10:00:00.000Z",
        url: "https://example.com/posts/1",
        body: "Version 1 is live.",
      }),
    ]);
  });
});

function mcpManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    version: 1,
    id: "gmail-test",
    name: "Gmail test",
    transport: {
      type: "mcp",
      url: "https://fake.example/mcp/v1",
      tool: "search_threads",
      arguments: { q: "newer_than:14d" },
      auth: { type: "bearer", binding: "PLUGIN_SECRET_GMAIL" },
    },
    itemsPath: "threads",
    mapping: {
      id: { path: "id" },
      kind: { value: "email" },
      title: { path: "messages.0.subject" },
      timestamp: { path: "messages.0.date" },
      body: { path: "messages.0.plaintextBody" },
      facets: [
        {
          type: "author",
          fields: { actor: { path: "messages.0.sender" } },
          capabilities: [{ name: "has-author", primitive: "actor", field: "actor" }],
        },
        { derive: "course-mention", from: ["title", "body"] },
      ],
    },
    ...overrides,
  } as PluginManifest;
}

const thread = {
  id: "t1",
  messages: [
    {
      subject: "Re: FIT2004 extension",
      date: "2026-08-01T00:00:00.000Z",
      plaintextBody: "See the FIT2004 spec for details.",
      sender: "professor@example.edu",
    },
  ],
};

describe("DeclarativePlugin.pull (MCP transport)", () => {
  it("pulls items via structuredContent, applying the bearer binding as Authorization", async () => {
    const { fetcher, lastAuth } = fakeMcpServer((server) => {
      server.registerTool(
        "search_threads",
        { description: "test", inputSchema: { q: z.string().optional() } },
        async () => ({
          content: [{ type: "text" as const, text: "{}" }],
          structuredContent: { threads: [thread] },
        }),
      );
    });
    const plugin = new DeclarativePlugin(mcpManifest(), { PLUGIN_SECRET_GMAIL: "secret-token" }, fetcher);

    const items = await plugin.pull();

    expect(lastAuth()).toBe("Bearer secret-token");
    expect(items).toEqual([
      expect.objectContaining({
        id: "t1",
        source: "gmail-test",
        kind: "email",
        title: "Re: FIT2004 extension",
        timestamp: "2026-08-01T00:00:00.000Z",
        body: "See the FIT2004 spec for details.",
        facets: [
          {
            type: "author",
            data: { actor: "professor@example.edu" },
            capabilities: [{ name: "has-author", primitive: "actor", field: "actor" }],
          },
          {
            type: "course-mention",
            data: { codes: ["FIT2004"] },
            capabilities: [],
          },
        ],
      }),
    ]);
  });

  it("falls back to parsing the first text content block when there is no structuredContent", async () => {
    const { fetcher } = fakeMcpServer((server) => {
      server.registerTool("search_threads", { description: "test", inputSchema: {} }, async () => ({
        content: [{ type: "text" as const, text: JSON.stringify({ threads: [thread] }) }],
      }));
    });
    const plugin = new DeclarativePlugin(mcpManifest(), { PLUGIN_SECRET_GMAIL: "secret" }, fetcher);

    const items = await plugin.pull();

    expect(items).toEqual([expect.objectContaining({ id: "t1" })]);
  });

  it("omits the course-mention facet when no unit code is mentioned", async () => {
    const { fetcher } = fakeMcpServer((server) => {
      server.registerTool("search_threads", { description: "test", inputSchema: {} }, async () => ({
        content: [{ type: "text" as const, text: "{}" }],
        structuredContent: {
          threads: [
            {
              id: "t2",
              messages: [{ subject: "Lunch?", date: "2026-08-01T00:00:00.000Z", plaintextBody: "Free at noon?", sender: "a@b.com" }],
            },
          ],
        },
      }));
    });
    const plugin = new DeclarativePlugin(mcpManifest(), { PLUGIN_SECRET_GMAIL: "secret" }, fetcher);

    const [item] = await plugin.pull();

    expect(item.facets.map((facet) => facet.type)).toEqual(["author"]);
  });

  it("uses the injected OAuth token source when transport auth is oauth", async () => {
    const { fetcher, lastAuth } = fakeMcpServer((server) => {
      server.registerTool("search_threads", { description: "test", inputSchema: {} }, async () => ({
        content: [{ type: "text" as const, text: "{}" }],
        structuredContent: { threads: [thread] },
      }));
    });
    const tokenSource = vi.fn().mockResolvedValue("oauth-access-token");
    const manifest = mcpManifest({
      transport: { type: "mcp", url: "https://fake.example/mcp/v1", tool: "search_threads", auth: { type: "oauth", provider: "google" } },
    } as Partial<PluginManifest>);

    const plugin = new DeclarativePlugin(manifest, {}, fetcher, tokenSource);
    await plugin.pull();

    expect(tokenSource).toHaveBeenCalledWith("gmail-test");
    expect(lastAuth()).toBe("Bearer oauth-access-token");
  });

  it("fails with mcp_unauthorized when oauth auth has no token source configured", async () => {
    const manifest = mcpManifest({
      transport: { type: "mcp", url: "https://fake.example/mcp/v1", tool: "search_threads", auth: { type: "oauth", provider: "google" } },
    } as Partial<PluginManifest>);
    const fetcher = vi.fn<typeof fetch>();

    const plugin = new DeclarativePlugin(manifest, {}, fetcher);

    await expect(plugin.pull()).rejects.toMatchObject({ code: "mcp_unauthorized" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails with mcp_unauthorized when the MCP server rejects the bearer token", async () => {
    const plugin = new DeclarativePlugin(mcpManifest(), { PLUGIN_SECRET_GMAIL: "bad-token" }, unauthorizedFetcher());

    await expect(plugin.pull()).rejects.toMatchObject({ code: "mcp_unauthorized" });
  });

  it("fails with mcp_tool_failed when the tool call returns isError", async () => {
    const { fetcher } = fakeMcpServer((server) => {
      server.registerTool("search_threads", { description: "test", inputSchema: {} }, async () => ({
        isError: true,
        content: [{ type: "text" as const, text: "upstream quota exceeded" }],
      }));
    });
    const plugin = new DeclarativePlugin(mcpManifest(), { PLUGIN_SECRET_GMAIL: "secret" }, fetcher);

    await expect(plugin.pull()).rejects.toMatchObject({ code: "mcp_tool_failed" });
  });

  it("fails with mcp_bad_payload when the text content is not valid JSON", async () => {
    const { fetcher } = fakeMcpServer((server) => {
      server.registerTool("search_threads", { description: "test", inputSchema: {} }, async () => ({
        content: [{ type: "text" as const, text: "not json" }],
      }));
    });
    const plugin = new DeclarativePlugin(mcpManifest(), { PLUGIN_SECRET_GMAIL: "secret" }, fetcher);

    await expect(plugin.pull()).rejects.toMatchObject({ code: "mcp_bad_payload" });
  });

  it("fails with mcp_bad_payload when itemsPath does not resolve to an array", async () => {
    const { fetcher } = fakeMcpServer((server) => {
      server.registerTool("search_threads", { description: "test", inputSchema: {} }, async () => ({
        content: [{ type: "text" as const, text: "{}" }],
        structuredContent: { threads: { not: "an array" } },
      }));
    });
    const plugin = new DeclarativePlugin(mcpManifest(), { PLUGIN_SECRET_GMAIL: "secret" }, fetcher);

    const error = await plugin.pull().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeclarativeMcpError);
    expect(error).toMatchObject({ code: "mcp_bad_payload" });
  });
});

describe("PluginManifest schema (MCP transport)", () => {
  it("parses a manifest with an mcp transport and oauth auth", () => {
    expect(() => parsePluginManifest(mcpManifest())).not.toThrow();
    const oauthManifest = mcpManifest({
      transport: { type: "mcp", url: "https://fake.example/mcp/v1", tool: "search_threads", auth: { type: "oauth", provider: "google" } },
    } as Partial<PluginManifest>);
    expect(() => parsePluginManifest(oauthManifest)).not.toThrow();
  });

  it("rejects an mcp transport auth with an unsupported oauth provider", () => {
    const manifest = mcpManifest({
      transport: { type: "mcp", url: "https://fake.example/mcp/v1", tool: "search_threads", auth: { type: "oauth", provider: "github" } },
    } as unknown as Partial<PluginManifest>);
    expect(() => parsePluginManifest(manifest)).toThrow();
  });

  it("rejects a non-https mcp transport url", () => {
    const manifest = mcpManifest({
      transport: { type: "mcp", url: "http://fake.example/mcp/v1", tool: "search_threads" },
    } as Partial<PluginManifest>);
    expect(() => parsePluginManifest(manifest)).toThrow();
  });

  it("accepts a derived course-mention facet in mapping.facets", () => {
    const manifest = mcpManifest();
    expect(() => parsePluginManifest(manifest)).not.toThrow();
  });

  it("still parses an existing http/rss manifest unchanged", () => {
    const manifest = {
      version: 1,
      id: "example-issues",
      name: "Example issues",
      format: "json",
      url: "https://api.example.com/issues",
      mapping: { id: { path: "id" }, kind: { value: "issue" }, title: { path: "t" }, timestamp: { path: "ts" } },
    };
    expect(() => parsePluginManifest(manifest)).not.toThrow();
  });
});

// --- Pagination and fan-out (the planned extension, ARCHITECTURE §5 / ADR-0017/0038) ---

const paginationMapping = {
  id: { path: "id" },
  kind: { value: "issue" },
  title: { path: "title" },
  timestamp: { path: "ts" },
};

describe("DeclarativePlugin.pull (pagination)", () => {
  it("follows link-header pagination across pages and stops when there is no next link", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "paged-issues",
      name: "Paged issues",
      format: "json",
      url: "https://api.example.com/issues",
      pagination: { type: "link-header" },
      mapping: paginationMapping,
    };
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(
      Response.json([{ id: 1, title: "one", ts: "2026-01-01T00:00:00.000Z" }], {
        headers: { Link: '<https://api.example.com/issues?page=2>; rel="next"' },
      }),
    );
    fetcher.mockResolvedValueOnce(
      Response.json([{ id: 2, title: "two", ts: "2026-01-02T00:00:00.000Z" }], {
        headers: { Link: '<https://api.example.com/issues?page=3>; rel="next"' },
      }),
    );
    fetcher.mockResolvedValueOnce(Response.json([{ id: 3, title: "three", ts: "2026-01-03T00:00:00.000Z" }]));

    const items = await new DeclarativePlugin(manifest, {}, fetcher).pull();

    expect(items.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[0]?.toString()).toBe("https://api.example.com/issues?page=2");
  });

  it("follows cursor pagination via cursorPath/param and stops once the response has no cursor", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "cursor-issues",
      name: "Cursor issues",
      format: "json",
      url: "https://api.example.com/issues",
      itemsPath: "items",
      pagination: { type: "cursor", cursorPath: "nextCursor", param: "cursor" },
      mapping: paginationMapping,
    };
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(
      Response.json({ items: [{ id: 1, title: "one", ts: "2026-01-01T00:00:00.000Z" }], nextCursor: "c2" }),
    );
    fetcher.mockResolvedValueOnce(
      Response.json({ items: [{ id: 2, title: "two", ts: "2026-01-02T00:00:00.000Z" }], nextCursor: null }),
    );

    const items = await new DeclarativePlugin(manifest, {}, fetcher).pull();

    expect(items.map((item) => item.id)).toEqual(["1", "2"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetcher.mock.calls[1]?.[0] as string | URL);
    expect(secondUrl.searchParams.get("cursor")).toBe("c2");
  });

  it("follows page pagination and stops on an empty page", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "page-issues",
      name: "Page issues",
      format: "json",
      url: "https://api.example.com/issues",
      pagination: { type: "page", param: "page", start: 1 },
      mapping: paginationMapping,
    };
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(Response.json([{ id: 1, title: "one", ts: "2026-01-01T00:00:00.000Z" }]));
    fetcher.mockResolvedValueOnce(Response.json([{ id: 2, title: "two", ts: "2026-01-02T00:00:00.000Z" }]));
    fetcher.mockResolvedValueOnce(Response.json([]));

    const items = await new DeclarativePlugin(manifest, {}, fetcher).pull();

    expect(items.map((item) => item.id)).toEqual(["1", "2"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new URL(fetcher.mock.calls[2]?.[0] as string | URL).searchParams.get("page")).toBe("3");
  });

  it("caps at maxPages even when the source keeps offering a next link", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "capped-issues",
      name: "Capped issues",
      format: "json",
      url: "https://api.example.com/issues",
      pagination: { type: "link-header", maxPages: 2 },
      mapping: paginationMapping,
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(input as string | URL);
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json([{ id: page, title: `page ${page}`, ts: "2026-01-01T00:00:00.000Z" }], {
        headers: { Link: `<https://api.example.com/issues?page=${page + 1}>; rel="next"` },
      });
    });

    const items = await new DeclarativePlugin(manifest, {}, fetcher).pull();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(items.map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("refuses a pagination next link on a different origin and never contacts it", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "hijack-issues",
      name: "Hijack issues",
      format: "json",
      url: "https://api.example.com/issues",
      pagination: { type: "link-header" },
      mapping: paginationMapping,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json([{ id: 1, title: "one", ts: "2026-01-01T00:00:00.000Z" }], {
        headers: { Link: '<https://evil.example/collect>; rel="next"' },
      }),
    );

    await expect(new DeclarativePlugin(manifest, {}, fetcher).pull()).rejects.toThrow(/different origin/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("DeclarativePlugin.pull (fan-out)", () => {
  it("fans out over a parent list, substituting placeholders and reading $parent fields in the mapping", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "course-assignments",
      name: "Course assignments",
      format: "json",
      url: "https://api.example.com/courses/{{course.id}}/assignments",
      itemsPath: "assignments",
      fanOut: {
        from: { url: "https://api.example.com/courses", itemsPath: "courses" },
        as: "course",
        max: 3,
      },
      mapping: {
        id: { path: "id" },
        kind: { value: "assignment" },
        title: { path: "name" },
        timestamp: { path: "due_at" },
        body: { path: "$parent.code" },
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(input as string | URL);
      if (url.pathname === "/courses") {
        return Response.json({
          courses: [
            { id: 1, code: "FIT2004" },
            { id: 2, code: "FIT2099" },
            { id: 3, code: "FIT1045" },
          ],
        });
      }
      const courseId = url.pathname.match(/\/courses\/(\d+)\/assignments/)?.[1];
      return Response.json({
        assignments: [{ id: `${courseId}-a1`, name: `Assignment for ${courseId}`, due_at: "2026-08-01T00:00:00.000Z" }],
      });
    });

    const items = await new DeclarativePlugin(manifest, {}, fetcher).pull();

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.body)).toEqual(["FIT2004", "FIT2099", "FIT1045"]);
    expect(fetcher).toHaveBeenCalledTimes(4); // 1 parent-list fetch + 3 per-course fetches
  });

  it("fails loudly instead of truncating silently when a pull would exceed the 25-subrequest budget", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "budget-blowout",
      name: "Budget blowout",
      format: "json",
      url: "https://api.example.com/courses/{{course.id}}/pages",
      itemsPath: "items",
      pagination: { type: "page", param: "page", start: 1, maxPages: 10 },
      fanOut: {
        from: { url: "https://api.example.com/courses", itemsPath: "courses" },
        as: "course",
        max: 20,
      },
      mapping: { id: { path: "id" }, kind: { value: "x" }, title: { path: "id" }, timestamp: { value: "2026-01-01T00:00:00.000Z" } },
    };
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      calls += 1;
      const url = new URL(input as string | URL);
      if (url.pathname === "/courses") {
        return Response.json({ courses: Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })) });
      }
      return Response.json({ items: [{ id: calls }] }); // always non-empty: pagination never stops on its own
    });

    await expect(new DeclarativePlugin(manifest, {}, fetcher).pull()).rejects.toThrow(/subrequest budget/);
    expect(fetcher).toHaveBeenCalledTimes(25);
  });
});

// A hostile or just misbehaving server can return an arbitrarily large body;
// neither response.text() nor response.json() caps how much they'll buffer, and a
// Worker has a hard memory ceiling shared with the rest of the invocation. These
// build a real streamed Response — Content-Length omitted, exactly like a
// chunked-transfer response — so the byte count is only ever known from the stream
// itself, never trusted from a header.
function hugeStreamedResponse(totalBytes: number, contentType: string): Response {
  const chunk = new Uint8Array(64 * 1024).fill(65); // 64KB of 'A'
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunk.byteLength, totalBytes - sent);
      controller.enqueue(chunk.subarray(0, size));
      sent += size;
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

describe("DeclarativePlugin.pull (response size limit)", () => {
  const oneRecordMapping = { id: { path: "id" }, kind: { value: "x" }, title: { path: "id" }, timestamp: { value: "2026-01-01T00:00:00.000Z" } };

  it("rejects a JSON response over the size cap instead of buffering it whole", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "huge-json",
      name: "Huge JSON",
      format: "json",
      url: "https://api.example.com/items",
      mapping: oneRecordMapping,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(hugeStreamedResponse(6 * 1024 * 1024, "application/json"));

    await expect(new DeclarativePlugin(manifest, {}, fetcher).pull()).rejects.toThrow(/exceeded .* bytes/);
  });

  it("rejects an RSS response over the size cap instead of buffering it whole", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "huge-rss",
      name: "Huge RSS",
      format: "rss",
      url: "https://api.example.com/feed.xml",
      mapping: oneRecordMapping,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(hugeStreamedResponse(6 * 1024 * 1024, "application/rss+xml"));

    await expect(new DeclarativePlugin(manifest, {}, fetcher).pull()).rejects.toThrow(/exceeded .* bytes/);
  });

  it("still accepts a normal-sized response comfortably under the cap", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "small-json",
      name: "Small JSON",
      format: "json",
      url: "https://api.example.com/items",
      itemsPath: "items",
      mapping: oneRecordMapping,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [{ id: 1 }] }));

    const items = await new DeclarativePlugin(manifest, {}, fetcher).pull();
    expect(items.map((item) => item.id)).toEqual(["1"]);
  });
});

describe("DeclarativePlugin.pull (secret-in-URL never reaches a thrown error message)", () => {
  // auth.type "query" puts the plugin secret straight into the request URL's
  // query string. src/runtime/cycle.ts's scheduler logs any pull failure's
  // error.message verbatim as observability data, so a network-level fetch
  // failure (as opposed to an HTTP error status, which throws a fixed
  // message already) must never be allowed to carry that URL — and thus the
  // secret — out through Error.message.
  it("never leaks the query-string secret through a network-level fetch failure", async () => {
    const manifest: PluginManifest = {
      version: 1,
      id: "query-auth-feed",
      name: "Query auth feed",
      format: "json",
      url: "https://api.example.com/items",
      auth: { type: "query", name: "api_key", binding: "PLUGIN_SECRET_FEED" },
      mapping: { id: { path: "id" }, kind: { value: "x" }, title: { path: "id" }, timestamp: { value: "2026-01-01T00:00:00.000Z" } },
    };
    const secret = "s3cr3t-token-should-never-appear-in-logs";
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      // Simulate a fetch implementation that echoes the request URL (with the
      // secret still in its query string) into a thrown error's message —
      // exactly the shape of error a DNS/TLS/connection failure can take.
      throw new TypeError(`fetch failed: ${String(input)}`);
    });

    await expect(new DeclarativePlugin(manifest, { PLUGIN_SECRET_FEED: secret }, fetcher).pull()).rejects.toThrow(
      "Declarative plugin query-auth-feed request failed.",
    );
    // Belt and suspenders: assert the secret is not merely absent from the
    // *asserted* message above, but from anything pull() could have thrown.
    try {
      await new DeclarativePlugin(manifest, { PLUGIN_SECRET_FEED: secret }, fetcher).pull();
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });
});

describe("PluginManifest schema (pagination & fan-out)", () => {
  const baseMapping = { id: { path: "id" }, kind: { value: "x" }, title: { path: "t" }, timestamp: { path: "ts" } };

  it("rejects an unknown pagination type", () => {
    const manifest = {
      version: 1,
      id: "bad-pg",
      name: "x",
      format: "json",
      url: "https://api.example.com/x",
      pagination: { type: "offset" },
      mapping: baseMapping,
    };
    expect(() => parsePluginManifest(manifest)).toThrow();
  });

  it("rejects a maxPages of 0 and a maxPages over the hard cap of 10", () => {
    const tooLow = {
      version: 1, id: "pg-low", name: "x", format: "json", url: "https://api.example.com/x",
      pagination: { type: "link-header", maxPages: 0 },
      mapping: baseMapping,
    };
    const tooHigh = {
      version: 1, id: "pg-high", name: "x", format: "json", url: "https://api.example.com/x",
      pagination: { type: "link-header", maxPages: 11 },
      mapping: baseMapping,
    };
    expect(() => parsePluginManifest(tooLow)).toThrow();
    expect(() => parsePluginManifest(tooHigh)).toThrow();
  });

  it("rejects a fanOut.max of 0 and one over the cap of 20", () => {
    const from = { url: "https://api.example.com/courses" };
    const tooLow = {
      version: 1, id: "fo-low", name: "x", format: "json", url: "https://api.example.com/{{c.id}}",
      fanOut: { from, as: "c", max: 0 },
      mapping: baseMapping,
    };
    const tooHigh = {
      version: 1, id: "fo-high", name: "x", format: "json", url: "https://api.example.com/{{c.id}}",
      fanOut: { from, as: "c", max: 21 },
      mapping: baseMapping,
    };
    expect(() => parsePluginManifest(tooLow)).toThrow();
    expect(() => parsePluginManifest(tooHigh)).toThrow();
  });

  it("rejects a manifest url placeholder that references an unknown var", () => {
    const manifest = {
      version: 1, id: "unk-var", name: "x", format: "json",
      url: "https://api.example.com/{{course.id}}/x",
      mapping: baseMapping,
    };
    expect(() => parsePluginManifest(manifest)).toThrow(/unknown placeholder var/);
  });

  it("rejects a placeholder whose var name does not match fanOut.as", () => {
    const manifest = {
      version: 1, id: "mismatch-var", name: "x", format: "json",
      url: "https://api.example.com/{{other.id}}/x",
      fanOut: { from: { url: "https://api.example.com/parents" }, as: "course", max: 5 },
      mapping: baseMapping,
    };
    expect(() => parsePluginManifest(manifest)).toThrow(/unknown placeholder var/);
  });

  it("rejects a mapping $parent reference when the manifest has no fanOut", () => {
    const manifest = {
      version: 1, id: "orphan-parent", name: "x", format: "json", url: "https://api.example.com/x",
      mapping: { ...baseMapping, body: { path: "$parent.code" } },
    };
    expect(() => parsePluginManifest(manifest)).toThrow(/\$parent/);
  });

  it("rejects pagination or fanOut on an rss manifest", () => {
    const withPagination = {
      version: 1, id: "rss-pg", name: "x", format: "rss", url: "https://example.com/feed.xml",
      pagination: { type: "link-header" },
      mapping: baseMapping,
    };
    // ZodError.message is JSON with escaped quotes, so match the unquoted words.
    expect(() => parsePluginManifest(withPagination)).toThrow(/only support format/);
  });

  it("rejects fanOut on the mcp transport", () => {
    const manifest = {
      version: 1, id: "mcp-fanout", name: "x",
      transport: { type: "mcp", url: "https://fake.example/mcp/v1", tool: "search" },
      fanOut: { from: { url: "https://api.example.com/parents" }, as: "p", max: 5 },
      mapping: baseMapping,
    };
    expect(() => parsePluginManifest(manifest)).toThrow(/mcp transport/);
  });

  it("accepts a valid paginated manifest and a valid fan-out manifest", () => {
    const paginated = {
      version: 1, id: "ok-pg", name: "x", format: "json", url: "https://api.example.com/x",
      pagination: { type: "cursor", cursorPath: "next", param: "cursor" },
      mapping: baseMapping,
    };
    const fannedOut = {
      version: 1, id: "ok-fo", name: "x", format: "json",
      url: "https://api.example.com/courses/{{course.id}}/assignments",
      fanOut: { from: { url: "https://api.example.com/courses" }, as: "course", max: 10 },
      mapping: { ...baseMapping, body: { path: "$parent.code" } },
    };
    expect(() => parsePluginManifest(paginated)).not.toThrow();
    expect(() => parsePluginManifest(fannedOut)).not.toThrow();
  });
});
