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
