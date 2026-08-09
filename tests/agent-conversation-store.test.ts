import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { D1AgentConversationStore } from "../src/agent/d1-conversation-store";

describe("D1AgentConversationStore", () => {
  it("atomically commits history, idempotency result, and measured usage", async () => {
    const batch = vi.fn().mockResolvedValue([]);
    const preparedSql: string[] = [];
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          bind(...values: unknown[]) {
            return { sql, values };
          },
        };
      },
      batch,
    } as unknown as D1Database;
    const store = new D1AgentConversationStore(db);
    const messages: Message[] = [
      { role: "user", content: "Hello", timestamp: 1 },
      fauxAssistantMessage("Hi", { timestamp: 2 }),
    ];

    await store.commitTurn({
      conversationId: "operator",
      messages,
      idempotencyKey: "request-1",
      result: {
        conversationId: "operator",
        answer: "Hi",
        toolsUsed: [],
        usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
      },
      run: {
        jobId: "resident-agent",
        status: "completed",
        inputTokens: 4,
        outputTokens: 1,
        totalTokens: 5,
        createdAt: "2026-08-09T00:00:00.000Z",
      },
    });

    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]?.[0]).toHaveLength(6);
    expect(preparedSql.some((sql) => sql.includes("INSERT INTO agent_turn_results"))).toBe(true);
    expect(preparedSql.some((sql) => sql.includes("INSERT INTO agent_job_runs"))).toBe(true);
  });

  it("resets only conversation history and idempotency rows", async () => {
    const batch = vi.fn().mockResolvedValue([]);
    const preparedSql: string[] = [];
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          bind(...values: unknown[]) {
            return { sql, values };
          },
        };
      },
      batch,
    } as unknown as D1Database;

    await new D1AgentConversationStore(db).reset("operator");

    expect(batch).toHaveBeenCalledOnce();
    expect(preparedSql).toHaveLength(3);
    expect(preparedSql.every((sql) => /agent_(turn_results|messages|conversations)/.test(sql))).toBe(true);
    expect(preparedSql.join(" ")).not.toContain("items");
    expect(preparedSql.join(" ")).not.toContain("agent_notes");
  });
});
