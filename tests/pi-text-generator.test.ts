import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type Context,
  type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  PiTextGenerator,
  WorkersAiPiRuntime,
  type PiModelRuntime,
  type WorkersAiBinding,
} from "../src/agent/pi-model";

const usage: Usage = {
  input: 12,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 17,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fauxRuntime(response: ReturnType<typeof fauxAssistantMessage>) {
  const model = {
    id: "test-model",
    name: "Test model",
    api: "faux",
    provider: "faux",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
  let callCount = 0;
  let maxTokens: number | undefined;
  const runtime: PiModelRuntime = {
    resolve() {
      return {
        model,
        stream: (_model, _context, options) => {
          callCount += 1;
          maxTokens = options?.maxTokens;
          const stream = createAssistantMessageEventStream();
          const message = { ...response, usage };
          queueMicrotask(() => {
            if (message.stopReason === "error" || message.stopReason === "aborted") {
              stream.push({ type: "error", reason: message.stopReason, error: message });
            } else if (message.stopReason === "pending") {
              throw new Error("A completed faux response cannot remain pending.");
            } else {
              stream.push({ type: "done", reason: message.stopReason, message });
            }
            stream.end(message);
          });
          return stream;
        },
      };
    },
  };
  return { runtime, callCount: () => callCount, maxTokens: () => maxTokens };
}

describe("PiTextGenerator", () => {
  it("returns text and measured usage through the existing generator seam", async () => {
    const fixture = fauxRuntime(fauxAssistantMessage("A compact digest."));
    const generator = new PiTextGenerator(fixture.runtime);

    await expect(
      generator.generate({ model: "test-model", prompt: "Summarize this.", maxOutputTokens: 321 }),
    ).resolves.toEqual({
      text: "A compact digest.",
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
    expect(fixture.maxTokens()).toBe(321);
    expect(fixture.callCount()).toBe(1);
  });

  it("surfaces provider failures instead of returning an empty success", async () => {
    const fixture = fauxRuntime(
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider unavailable" }),
    );
    const generator = new PiTextGenerator(fixture.runtime);

    await expect(
      generator.generate({ model: "test-model", prompt: "Summarize this.", maxOutputTokens: 321 }),
    ).rejects.toThrow("provider unavailable");
  });
});

describe("WorkersAiPiRuntime", () => {
  it("adapts a native Workers AI response into a Pi assistant message", async () => {
    const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
    const binding: WorkersAiBinding = {
      async run(model, input) {
        calls.push({ model, input });
        return {
          response: "The edge model is ready.",
          usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
        };
      },
    };
    const resolved = new WorkersAiPiRuntime(binding).resolve("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

    const result = await resolved.stream(resolved.model, userContext("Hello"), { maxTokens: 256 }).result();

    expect(result.content).toEqual([{ type: "text", text: "The edge model is ready." }]);
    expect(result.usage).toMatchObject({ input: 21, output: 7, totalTokens: 28 });
    expect(calls).toEqual([
      {
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        input: expect.objectContaining({
          messages: [expect.objectContaining({ role: "user", content: "Hello" })],
          max_tokens: 256,
        }),
      },
    ]);
  });

  it("preserves native Workers AI tool calls for the Pi agent loop", async () => {
    const binding: WorkersAiBinding = {
      async run() {
        return {
          tool_calls: [
            {
              id: "call_upcoming",
              type: "function",
              function: { name: "list_upcoming", arguments: '{"days":7}' },
            },
          ],
          usage: { prompt_tokens: 34, completion_tokens: 9, total_tokens: 43 },
        };
      },
    };
    const context = {
      ...userContext("What is due?"),
      tools: [
        {
          name: "list_upcoming",
          description: "List upcoming deadlines.",
          parameters: {
            type: "object",
            properties: { days: { type: "number" } },
            required: ["days"],
          },
        },
      ],
    } as unknown as Context;
    const resolved = new WorkersAiPiRuntime(binding).resolve("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

    const result = await resolved.stream(resolved.model, context).result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "toolCall", id: "call_upcoming", name: "list_upcoming", arguments: { days: 7 } },
    ]);
  });
});

function userContext(content: string): Context {
  return { messages: [{ role: "user", content, timestamp: 0 }] };
}
