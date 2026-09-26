import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { registerWidgetResources, widgetToolMeta, WIDGETS, WIDGET_RESOURCE_MIME_TYPE } from "../src/widgets/index";
import { WIDGET_URIS } from "../src/mcp/door-contracts";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("registerWidgetResources", () => {
  it("registers exactly the six ADR-0037 widgets, at the door-contracts.ts URIs", async () => {
    const client = await connectClient();

    const { resources } = await client.listResources();

    expect(resources.map((resource) => resource.uri).sort()).toEqual(Object.values(WIDGET_URIS).sort());
    expect(resources).toHaveLength(6);
  });

  it("serves every widget as text/html;profile=mcp-app", async () => {
    const client = await connectClient();
    const { resources } = await client.listResources();

    for (const resource of resources) {
      expect(resource.mimeType).toBe(WIDGET_RESOURCE_MIME_TYPE);
    }
  });

  it("reads back the exact inlined HTML for each widget", async () => {
    const client = await connectClient();

    for (const [name, widget] of Object.entries(WIDGETS)) {
      const { contents } = await client.readResource({ uri: widget.uri });
      expect(contents).toHaveLength(1);
      const [content] = contents;
      expect(content.mimeType).toBe(WIDGET_RESOURCE_MIME_TYPE);
      expect(content).toHaveProperty("text");
      expect((content as { text: string }).text).toBe(widget.html);
      expect(name in WIDGET_URIS).toBe(true);
    }
  });

  it("declares an empty-domain CSP, so the sandboxed frame can reach nothing external", async () => {
    const client = await connectClient();
    const { resources } = await client.listResources();

    for (const resource of resources) {
      const csp = (resource._meta as any)?.ui?.csp;
      expect(csp).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
    }
  });
});

describe("widgetToolMeta", () => {
  it("carries both the MCP Apps resourceUri and ChatGPT's legacy alias, for the same URI", () => {
    const meta = widgetToolMeta("briefCard");
    expect(meta.ui).toMatchObject({ resourceUri: WIDGET_URIS.briefCard });
    expect(meta["openai/outputTemplate"]).toBe(WIDGET_URIS.briefCard);
  });

  it("is distinct per widget", () => {
    expect(widgetToolMeta("planChecklist")["openai/outputTemplate"]).toBe(WIDGET_URIS.planChecklist);
  });
});

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "unicorn-widgets-test", version: "0.0.0" });
  registerWidgetResources(server);

  const client = new Client({ name: "unicorn-widgets-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
