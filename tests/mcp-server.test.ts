import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUnicornMcpServer, type McpRepository } from "../src/mcp/server";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("unicorn MCP server", () => {
  it("serves upcoming items through the MCP tool interface", async () => {
    const repository = {
      listUpcoming: vi.fn().mockResolvedValue([
        {
          source: "campus-moodle",
          itemId: "assessment:99",
          title: "Assignment 3",
          dueAt: "2026-07-20T06:00:00.000Z",
          url: "https://learning.example.edu/calendar/view.php",
          facetType: "deadline",
          capability: "has-deadline",
        },
      ]),
    } as unknown as McpRepository;
    const client = await connectClient(repository);

    const result = await client.callTool({ name: "list_upcoming", arguments: { days: 14, limit: 10 } });

    expect(repository.listUpcoming).toHaveBeenCalledWith({ days: 14, includeOverdue: false, limit: 10 });
    expect(readToolJson(result)).toEqual([
      expect.objectContaining({ itemId: "assessment:99", title: "Assignment 3" }),
    ]);
  });

  it("rejects enabling an agent job when no AI key is configured", async () => {
    const repository = {
      configureAgentJob: vi.fn(),
    } as unknown as McpRepository;
    const client = await connectClient(repository, { aiConfigured: false });

    const result = await client.callTool({
      name: "configure_agent_job",
      arguments: { id: "daily-digest", enabled: true, model: "gpt-5-mini", monthlyTokenCap: 100000 },
    });

    expect(result.isError).toBe(true);
    expect(repository.configureAgentJob).not.toHaveBeenCalled();
    expect(JSON.stringify(readToolJson(result))).toContain("AI_API_KEY");
  });

  it("reports the last sync cycle through get_sync_status", async () => {
    const cycle = { at: "2026-07-19T00:00:00.000Z", errors: [], results: [] };
    const repository = {
      getSyncStatus: vi.fn().mockResolvedValue(cycle),
    } as unknown as McpRepository;
    const client = await connectClient(repository);

    const result = await client.callTool({ name: "get_sync_status", arguments: {} });

    expect(readToolJson(result)).toEqual(cycle);
  });
});

async function connectClient(repository: McpRepository, options?: { aiConfigured?: boolean }): Promise<Client> {
  const server = createUnicornMcpServer(repository, options);
  const client = new Client({ name: "unicorn-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function readToolJson(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((entry) => entry.type === "text")?.text;
  return JSON.parse(text ?? "null") as unknown;
}
