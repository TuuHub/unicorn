import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminMcpServer, type McpRepository } from "../src/mcp/server";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("unicorn admin MCP server", () => {
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

  it("reports the last sync cycle through get_sync_status", async () => {
    const cycle = { at: "2026-07-19T00:00:00.000Z", sources: [] };
    const repository = {
      getSyncStatus: vi.fn().mockResolvedValue(cycle),
    } as unknown as McpRepository;
    const client = await connectClient(repository);

    const result = await client.callTool({ name: "get_sync_status", arguments: {} });

    expect(readToolJson(result)).toEqual(cycle);
  });

  it("reads the corrections inbox through list_corrections", async () => {
    const note = { domain: "corrections", content: "- [2026-07-19] FIT2099 quizzes don't count.", updatedAt: "2026-07-19T00:00:00.000Z" };
    const repository = {
      listCorrections: vi.fn().mockResolvedValue(note),
    } as unknown as McpRepository;
    const client = await connectClient(repository);

    const result = await client.callTool({ name: "list_corrections", arguments: {} });

    expect(repository.listCorrections).toHaveBeenCalled();
    expect(readToolJson(result)).toMatchObject({ updatedAt: note.updatedAt, content: note.content });
  });
});

async function connectClient(repository: McpRepository): Promise<Client> {
  const server = createAdminMcpServer(repository);
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
