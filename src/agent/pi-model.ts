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
    const result = await ai.run(modelId, workersAiInput(modelId, payload), { signal: request.signal });
    return new Response(workersAiSse(modelId, result), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  };
}

function workersAiInput(modelId: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (modelId.startsWith("@cf/openai/gpt-oss-")) {
    return workersAiChatCompletionsInput(payload);
  }
  const supported = [
    "messages",
    "tools",
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "response_format",
  ];
  const input: Record<string, unknown> = Object.fromEntries(
    supported.flatMap((key) => (payload[key] === undefined ? [] : [[key, payload[key]]])),
  );
  if (input.messages !== undefined) {
    input.messages = normalizeWorkersAiMessages(input.messages);
  }
  if (input.tools !== undefined) {
    input.tools = normalizeWorkersAiTools(input.tools);
  }
  const maxTokens = payload.max_tokens ?? payload.max_completion_tokens;
  return maxTokens === undefined ? input : { ...input, max_tokens: maxTokens };
}

function workersAiChatCompletionsInput(payload: Record<string, unknown>): Record<string, unknown> {
  const supported = [
    "messages",
    "tools",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "response_format",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning_effort",
  ];
  const input: Record<string, unknown> = Object.fromEntries(
    supported.flatMap((key) => (payload[key] === undefined ? [] : [[key, payload[key]]])),
  );
  if (input.messages !== undefined) {
    input.messages = normalizeWorkersAiMessages(input.messages, true);
  }
  return input;
}

function normalizeWorkersAiMessages(value: unknown, preserveOpenAiToolHistory = false): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const toolNames = new Map<string, string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    const message = entry as Record<string, unknown>;
    if (Array.isArray(message.tool_calls)) {
      for (const entry of message.tool_calls) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const call = entry as Record<string, unknown>;
        const fn = call.function && typeof call.function === "object"
          ? call.function as Record<string, unknown>
          : null;
        if (typeof call.id === "string" && typeof fn?.name === "string") {
          toolNames.set(call.id, fn.name);
        }
      }
    }
    const toolName = message.role === "tool" && typeof message.tool_call_id === "string"
      ? toolNames.get(message.tool_call_id)
      : undefined;
    if (preserveOpenAiToolHistory) {
      return { ...message, content: workersAiTextContent(message.content) };
    }
    const { tool_calls: _toolCalls, tool_call_id: _toolCallId, ...nativeMessage } = message;
    return {
      ...nativeMessage,
      ...(typeof message.name !== "string" && toolName ? { name: toolName } : {}),
      content: workersAiTextContent(message.content),
    };
  });
}

function workersAiTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (!Array.isArray(value)) {
    throw new PiModelError("Workers AI received a non-text message.");
  }
  return value.map((part) => {
    if (part && typeof part === "object") {
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
    }
    throw new PiModelError("Workers AI received a non-text message part.");
  }).join("");
}

function normalizeWorkersAiTools(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    const tool = entry as Record<string, unknown>;
    if (tool.function && typeof tool.function === "object") {
      const fn = tool.function as Record<string, unknown>;
      return { ...tool, function: { ...fn, parameters: describeToolParameters(fn.parameters) } };
    }
    return { ...tool, parameters: describeToolParameters(tool.parameters) };
  });
}

function describeToolParameters(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const schema = value as Record<string, unknown>;
  if (!schema.properties || typeof schema.properties !== "object") {
    return value;
  }
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([name, property]) => {
    if (!property || typeof property !== "object") {
      return [name, property];
    }
    const descriptor = property as Record<string, unknown>;
    return [name, {
      ...descriptor,
      description: typeof descriptor.description === "string" && descriptor.description
        ? descriptor.description
        : `Value for ${name}.`,
    }];
  }));
  return { ...schema, properties };
}

function workersAiSse(modelId: string, result: Record<string, unknown>): string {
  const choice = workersAiChatChoice(result);
  const toolCalls = normalizeWorkersAiToolCalls(choice?.message.tool_calls ?? result.tool_calls);
  const response = typeof choice?.message.content === "string"
    ? choice.message.content
    : typeof result.response === "string"
      ? result.response
      : "";
  const finishReason = typeof choice?.finish_reason === "string"
    ? choice.finish_reason
    : toolCalls.length > 0
      ? "tool_calls"
      : "stop";
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
        finish_reason: finishReason,
      },
    ],
    usage: normalizeWorkersAiUsage(result.usage),
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

function workersAiChatChoice(result: Record<string, unknown>): {
  message: Record<string, unknown>;
  finish_reason?: unknown;
} | null {
  if (!Array.isArray(result.choices)) {
    return null;
  }
  const choice = result.choices[0];
  if (!choice || typeof choice !== "object") {
    return null;
  }
  const candidate = choice as Record<string, unknown>;
  if (!candidate.message || typeof candidate.message !== "object") {
    return null;
  }
  return {
    message: candidate.message as Record<string, unknown>,
    ...(candidate.finish_reason !== undefined ? { finish_reason: candidate.finish_reason } : {}),
  };
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
