import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/runtime/cycle";

describe("/agent", () => {
  it("requires the admin bearer token", async () => {
    const response = await worker.fetch(
      new Request("https://unicorn.example/agent", { method: "POST" }),
      environment().env,
      executionContext(),
    );

    expect(response.status).toBe(401);
  });

  it("routes a turn to the conversation Durable Object", async () => {
    const runtime = environment();
    const response = await worker.fetch(
      new Request("https://unicorn.example/agent", {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          conversationId: "operator",
          message: "What matters today?",
          idempotencyKey: "request-1",
        }),
      }),
      runtime.env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(runtime.idFromName).toHaveBeenCalledWith("operator");
    const forwarded = runtime.fetch.mock.calls[0]?.[0] as Request;
    await expect(forwarded.json()).resolves.toEqual({
      conversationId: "operator",
      message: "What matters today?",
      idempotencyKey: "request-1",
    });
  });

  it("routes conversation reset without deleting world state", async () => {
    const runtime = environment();
    const response = await worker.fetch(
      new Request("https://unicorn.example/agent?conversationId=operator", {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret" },
      }),
      runtime.env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const forwarded = runtime.fetch.mock.calls[0]?.[0] as Request;
    expect(forwarded.method).toBe("DELETE");
    expect(new URL(forwarded.url).pathname).toBe("/conversation");
  });
});

function environment() {
  const fetch = vi.fn().mockImplementation(async (request: Request) => {
    if (request.method === "DELETE") {
      return Response.json({ conversationId: "operator", reset: true });
    }
    return Response.json({
      conversationId: "operator",
      answer: "Focus on Assignment 3.",
      toolsUsed: ["list_upcoming"],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });
  const idFromName = vi.fn().mockReturnValue({ name: "operator" });
  const env = {
    ADMIN_TOKEN: "admin-secret",
    AGENT_SESSIONS: {
      idFromName,
      get: vi.fn().mockReturnValue({ fetch }),
    },
  } as unknown as Env;
  return { env, fetch, idFromName };
}

function executionContext(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
}
