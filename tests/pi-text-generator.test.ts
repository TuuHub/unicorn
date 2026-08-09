import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { PiTextGenerator, type PiModelRuntime } from "../src/agent/pi-model";

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
