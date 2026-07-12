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

    expect(repository.listUpcoming).toHaveBeenCalledWith({ days: 14, limit: 10 });
    expect(readToolJson(result)).toEqual([
      expect.objectContaining({ itemId: "assessment:99", title: "Assignment 3" }),
    ]);
  });
});

async function connectClient(repository: McpRepository): Promise<Client> {
  const server = createUnicornMcpServer(repository);
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
