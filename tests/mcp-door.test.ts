import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BriefStore } from "../src/briefs";
import { createDoorMcpServer, type DoorDeps } from "../src/mcp/door";
import type { MemoryStore } from "../src/memory";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("unicorn door MCP server", () => {
  it("exposes exactly the three door tools", async () => {
    const client = await connectClient(fakeDeps());

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(["ack_briefs", "get_briefs", "remember"]);
  });

  it("tells the client to pull briefs first and use remember for corrections", async () => {
    const client = await connectClient(fakeDeps());

    const instructions = client.getInstructions();

    expect(instructions).toContain("get_briefs");
    expect(instructions).toContain("remember");
  });

  it("lists briefs through get_briefs, defaulting to unread only", async () => {
    const list = vi.fn().mockResolvedValue([
      {
        id: "digest:2026-07-19",
        kind: "digest",
        subject: "2026-07-19",
        title: "unicorn daily digest",
        body: "Nothing urgent.",
        createdAt: "2026-07-19T00:00:00.000Z",
        readAt: null,
      },
    ]);
    const client = await connectClient(fakeDeps({ briefs: { list } as unknown as BriefStore }));

    const result = await client.callTool({ name: "get_briefs", arguments: {} });

    expect(list).toHaveBeenCalledWith({ unreadOnly: true, limit: 20 });
    expect(readToolJson(result)).toEqual([expect.objectContaining({ id: "digest:2026-07-19" })]);
  });

  it("acknowledges briefs by id", async () => {
    const markRead = vi.fn().mockResolvedValue(2);
    const client = await connectClient(fakeDeps({ briefs: { markRead } as unknown as BriefStore }));

    const result = await client.callTool({ name: "ack_briefs", arguments: { ids: ["a", "b"] } });

    expect(markRead).toHaveBeenCalledWith(["a", "b"]);
    expect(readToolJson(result)).toEqual({ acknowledged: 2 });
  });

  it("saves a remembered correction verbatim through the corrections domain", async () => {
    const save = vi.fn().mockResolvedValue({ domain: "corrections", content: "- [2026-07-19] noted", updatedAt: "x" });
    const get = vi.fn().mockResolvedValue({ domain: "corrections", content: "", updatedAt: "" });
    const client = await connectClient(fakeDeps({ memory: { get, save, list: vi.fn() } as unknown as MemoryStore }));

    const result = await client.callTool({ name: "remember", arguments: { text: "FIT2099 quizzes don't count" } });

    expect(save).toHaveBeenCalled();
    expect(readToolJson(result)).toEqual({ result: "saved" });
  });
});

function fakeDeps(overrides: Partial<DoorDeps> = {}): DoorDeps {
  return {
    briefs: {
      insert: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      markRead: vi.fn().mockResolvedValue(0),
      prune: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
      latestByKind: vi.fn().mockResolvedValue(null),
    } as unknown as BriefStore,
    memory: {
      get: vi.fn().mockResolvedValue({ domain: "corrections", content: "", updatedAt: "" }),
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue({ domain: "corrections", content: "", updatedAt: "" }),
    } as unknown as MemoryStore,
    ...overrides,
  };
}

async function connectClient(deps: DoorDeps): Promise<Client> {
  const server = await createDoorMcpServer(deps);
  const client = new Client({ name: "unicorn-door-test", version: "0.0.0" });
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
