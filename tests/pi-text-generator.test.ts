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

  it("adapts the native GPT-OSS chat completions response", async () => {
    const binding: WorkersAiBinding = {
      async run() {
        return {
          id: "chatcmpl-edge",
          object: "chat.completion",
          created: 1,
          model: "@cf/openai/gpt-oss-20b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "GPT-OSS is ready.", refusal: null },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
        };
      },
    };
    const resolved = new WorkersAiPiRuntime(binding).resolve("@cf/openai/gpt-oss-20b");

    const result = await resolved.stream(resolved.model, userContext("Hello")).result();

    expect(result.content).toEqual([{ type: "text", text: "GPT-OSS is ready." }]);
    expect(result.usage).toMatchObject({ input: 18, output: 6, totalTokens: 24 });
  });

  it("preserves native Workers AI tool calls for the Pi agent loop", async () => {
    let nativeInput: Record<string, unknown> = {};
    const binding: WorkersAiBinding = {
      async run(_model, input) {
        nativeInput = input;
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
    expect(nativeInput).toMatchObject({
      tools: [
        {
          function: {
            parameters: {
              properties: { days: { type: "number", description: expect.any(String) } },
            },
          },
        },
      ],
    });
  });

  it("normalizes Pi text parts and tool history for the native binding schema", async () => {
    let nativeInput: Record<string, unknown> = {};
    const binding: WorkersAiBinding = {
      async run(_model, input) {
        nativeInput = input;
        return { response: "Nothing is due." };
      },
    };
    const context = toolHistoryContext();
    const resolved = new WorkersAiPiRuntime(binding).resolve("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

    await resolved.stream(resolved.model, context).result();

    const messages = nativeInput.messages as Array<{
      role: string;
      content: unknown;
      name?: string;
      tool_calls?: unknown;
    }>;
    expect(messages).toHaveLength(4);
    expect(messages.every((message) => typeof message.content === "string")).toBe(true);
    expect(messages.find((message) => message.role === "assistant")?.tool_calls).toBeUndefined();
    expect(messages.find((message) => message.role === "tool")?.name).toBe("list_upcoming");
  });

  it("keeps GPT-OSS tool ids while normalizing message content", async () => {
    let nativeInput: Record<string, unknown> = {};
    const binding: WorkersAiBinding = {
      async run(_model, input) {
        nativeInput = input;
        return {
          choices: [
            {
              message: { role: "assistant", content: "Nothing is due." },
              finish_reason: "stop",
            },
          ],
        };
      },
    };
    const resolved = new WorkersAiPiRuntime(binding).resolve("@cf/openai/gpt-oss-20b");

    await resolved.stream(resolved.model, toolHistoryContext()).result();

    const messages = nativeInput.messages as Array<{
      role: string;
      content: unknown;
      tool_calls?: unknown;
      tool_call_id?: string;
    }>;
    expect(messages.every((message) => typeof message.content === "string")).toBe(true);
    expect(messages.find((message) => message.role === "assistant")?.tool_calls).toBeDefined();
    expect(messages.find((message) => message.role === "tool")?.tool_call_id).toBe("call_1");
  });
});

function userContext(content: string): Context {
  return { messages: [{ role: "user", content, timestamp: 0 }] };
}

function toolHistoryContext(): Context {
  return {
    systemPrompt: "Use tools for current data.",
    messages: [
      { role: "user", content: "What is due?", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "list_upcoming", arguments: { days: 7 } }],
        api: "openai-completions",
        provider: "cloudflare-workers-ai",
        model: "test",
        usage,
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "list_upcoming",
        content: [{ type: "text", text: "[]" }],
        isError: false,
        timestamp: 3,
      },
    ],
  } as unknown as Context;
}
