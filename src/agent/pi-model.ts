import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAiCompatible } from "@earendil-works/pi-ai/api/openai-completions";
import type { TextGeneration, TextGenerator } from "../jobs/daily-digest";

export interface ResolvedPiModel {
  model: Model<Api>;
  stream: StreamFunction<Api, SimpleStreamOptions>;
}

export interface PiModelRuntime {
  resolve(modelId: string): ResolvedPiModel;
}

export interface WorkersAiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
}

export interface PiRuntimeEnv {
  AI?: WorkersAiBinding;
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
}

export class PiModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiModelError";
  }
}

export class OpenAiCompatiblePiRuntime implements PiModelRuntime {
  private readonly baseUrl: string;

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      timeoutMs?: number;
    },
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  resolve(modelId: string): ResolvedPiModel {
    const model: Model<"openai-completions"> = {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "openai-compatible",
      baseUrl: this.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    };
    return {
      model,
      stream: (resolvedModel, context, streamOptions) =>
        streamOpenAiCompatible(resolvedModel as Model<"openai-completions">, context, {
          ...streamOptions,
          apiKey: this.options.apiKey,
          timeoutMs: streamOptions?.timeoutMs ?? this.options.timeoutMs ?? 30_000,
          maxRetries: streamOptions?.maxRetries ?? 1,
          maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? 5_000,
        }),
    };
  }
}

export class WorkersAiPiRuntime implements PiModelRuntime {
  constructor(
    private readonly ai: WorkersAiBinding,
    private readonly timeoutMs = 30_000,
  ) {}

  resolve(modelId: string): ResolvedPiModel {
    const model: Model<"openai-completions"> = {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "cloudflare-workers-ai",
      baseUrl: "https://workers-ai.binding/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 24_000,
      maxTokens: 4_096,
    };
    return {
      model,
      stream: (resolvedModel, context, streamOptions) =>
        streamOpenAiCompatible(resolvedModel as Model<"openai-completions">, context, {
          ...streamOptions,
          apiKey: "workers-ai-binding",
          fetch: workersAiFetch(this.ai, modelId),
          timeoutMs: streamOptions?.timeoutMs ?? this.timeoutMs,
          maxRetries: streamOptions?.maxRetries ?? 1,
          maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? 5_000,
        }),
    };
  }
}

export function createPiModelRuntime(env: PiRuntimeEnv): PiModelRuntime | null {
  if (env.AI_API_KEY) {
    return new OpenAiCompatiblePiRuntime({
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL ?? "https://api.openai.com/v1",
    });
  }
  return env.AI ? new WorkersAiPiRuntime(env.AI) : null;
}

export function piModelConfigured(env: PiRuntimeEnv): boolean {
  return Boolean(env.AI_API_KEY || env.AI);
}

export class PiTextGenerator implements TextGenerator {
  constructor(private readonly runtime: PiModelRuntime) {}

  async generate(input: { model: string; prompt: string; maxOutputTokens: number }): Promise<TextGeneration> {
    const resolved = this.runtime.resolve(input.model);
    const context: Context = {
      messages: [{ role: "user", content: input.prompt, timestamp: Date.now() }],
    };
    const response = await resolved.stream(resolved.model, context, {
      maxTokens: input.maxOutputTokens,
    }).result();

    if (
      response.stopReason === "error" ||
      response.stopReason === "aborted" ||
      response.stopReason === "pending"
    ) {
      throw new PiModelError(response.errorMessage ?? `Model request ${response.stopReason}.`);
    }

    const text = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (!text.trim()) {
      throw new PiModelError("Model returned no text.");
    }

    return {
      text,
      usage: {
        inputTokens: response.usage.input,
        outputTokens: response.usage.output,
        totalTokens: response.usage.totalTokens,
      },
    };
  }
}

function workersAiFetch(ai: WorkersAiBinding, modelId: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const payload = (await request.json()) as Record<string, unknown>;
    const result = await ai.run(modelId, workersAiInput(payload), { signal: request.signal });
    return new Response(workersAiSse(modelId, result), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  };
}

function workersAiInput(payload: Record<string, unknown>): Record<string, unknown> {
  const supported = [
    "messages",
    "tools",
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "response_format",
  ];
  const input = Object.fromEntries(supported.flatMap((key) => (payload[key] === undefined ? [] : [[key, payload[key]]])));
  const maxTokens = payload.max_tokens ?? payload.max_completion_tokens;
  return maxTokens === undefined ? input : { ...input, max_tokens: maxTokens };
}

function workersAiSse(modelId: string, result: Record<string, unknown>): string {
  const toolCalls = normalizeWorkersAiToolCalls(result.tool_calls);
  const response = typeof result.response === "string" ? result.response : "";
  const chunk = {
    id: `workers-ai-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: modelId,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          ...(response ? { content: response } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: normalizeWorkersAiUsage(result.usage),
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

function normalizeWorkersAiToolCalls(value: unknown): Array<{
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const call = entry as Record<string, unknown>;
    const fn = call.function && typeof call.function === "object"
      ? call.function as Record<string, unknown>
      : call;
    if (typeof fn.name !== "string" || !fn.name) {
      return [];
    }
    const args = fn.arguments;
    return [{
      index,
      id: typeof call.id === "string" && call.id ? call.id : `call_${index + 1}`,
      type: "function" as const,
      function: {
        name: fn.name,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    }];
  });
}

function normalizeWorkersAiUsage(value: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const promptTokens = finiteNumber(usage.prompt_tokens);
  const completionTokens = finiteNumber(usage.completion_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: finiteNumber(usage.total_tokens) || promptTokens + completionTokens,
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
