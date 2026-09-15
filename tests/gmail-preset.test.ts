import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it } from "vitest";
import { DeclarativePlugin, parsePluginManifest } from "../src/plugins/declarative/plugin";
import gmailPreset from "../src/plugins/presets/gmail.json";

describe("Gmail preset manifest", () => {
  it("parses as a valid mcp-transport, oauth-authenticated manifest", () => {
    const manifest = parsePluginManifest(gmailPreset);

    expect(manifest.id).toBe("gmail");
    expect("transport" in manifest && manifest.transport.type).toBe("mcp");
    expect("transport" in manifest && manifest.transport.auth).toEqual({ type: "oauth", provider: "google" });
    expect("transport" in manifest && manifest.transport.tool).toBe("search_threads");
  });

  // Payload shaped per Google's published search_threads response schema:
  // https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/search_threads
  it("maps a search_threads-shaped response into an Item with author and course-mention facets", async () => {
    const payload = {
      threads: [
        {
          id: "thread-1",
          messages: [
            {
              id: "msg-1",
              snippet: "Reminder about FIT2004",
              subject: "FIT2004 assignment 2 reminder",
              sender: "unit-staff@monash.edu",
              toRecipients: ["student@student.monash.edu"],
              date: "2026-08-10T02:00:00.000Z",
              snippet: "Assignment 2 for FIT2004 is due Friday.",
              htmlBody: "<p>Assignment 2 for FIT2004 is due Friday.</p>",
              labelIds: ["INBOX"],
            },
          ],
        },
      ],
      nextPageToken: "",
      resultCountEstimate: "1",
    };

    const items = await pullPresetAgainst(payload);

    expect(items).toEqual([
      expect.objectContaining({
        id: "thread-1",
        source: "gmail",
        kind: "email",
        title: "FIT2004 assignment 2 reminder",
        timestamp: "2026-08-10T02:00:00.000Z",
        body: "Assignment 2 for FIT2004 is due Friday.",
        facets: [
          expect.objectContaining({ type: "author", data: { actor: "unit-staff@monash.edu" } }),
          expect.objectContaining({ type: "course-mention", data: { codes: ["FIT2004"] } }),
        ],
      }),
    ]);
  });

  it("omits the course-mention facet for a thread mentioning no unit code", async () => {
    const payload = {
      threads: [
        {
          id: "thread-2",
          messages: [
            { subject: "Coffee?", date: "2026-08-10T02:00:00.000Z", snippet: "Free later?", sender: "friend@example.com" },
          ],
        },
      ],
    };

    const [item] = await pullPresetAgainst(payload);

    expect(item.facets.map((facet) => facet.type)).toEqual(["author"]);
  });
});

// Exercises the preset's real pullMcp() path (not a reimplementation of the mapper)
// by standing up a throwaway in-process MCP server that returns exactly `payload`.
async function pullPresetAgainst(payload: unknown) {
  const manifest = parsePluginManifest(gmailPreset);
  const server = new McpServer({ name: "fake-gmail-mcp", version: "1.0.0" });
  server.registerTool("search_threads", { description: "test" }, async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => randomUUID(),
  });
  const ready = server.connect(transport);
  const fetcher: typeof fetch = async (input, init) => {
    await ready;
    return transport.handleRequest(new Request(input as URL | string, init));
  };
  const plugin = new DeclarativePlugin(manifest, {}, fetcher, async () => "token");
  return plugin.pull();
}
