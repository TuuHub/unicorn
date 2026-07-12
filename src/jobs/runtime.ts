import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { D1McpRepository } from "../mcp/d1-repository";
import type { DigestDataSource, TextGeneration, TextGenerator } from "./daily-digest";

export class D1DigestDataSource implements DigestDataSource {
  private readonly queries: D1McpRepository;

  constructor(db: D1Database) {
    this.queries = new D1McpRepository(db);
  }

  listRecentEvents(since: string, limit: number) {
    return this.queries.listEvents({ since, limit });
  }

  async listUpcoming(days: number, limit: number) {
    return (await this.queries.listUpcoming({ days, limit })).map((item) => ({
      title: item.title,
      dueAt: item.dueAt,
      source: item.source,
    }));
  }
}

export class AiSdkTextGenerator implements TextGenerator {
  private readonly provider: ReturnType<typeof createOpenAICompatible>;

  constructor(options: { apiKey: string; baseUrl: string }) {
    this.provider = createOpenAICompatible({
      name: "unicorn-byok",
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
    });
  }

  async generate(input: { model: string; prompt: string; maxOutputTokens: number }): Promise<TextGeneration> {
    const result = await generateText({
      model: this.provider(input.model),
      prompt: input.prompt,
      maxOutputTokens: input.maxOutputTokens,
    });
    const inputTokens = result.usage.inputTokens ?? 0;
    const outputTokens = result.usage.outputTokens ?? 0;
    return {
      text: result.text,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: result.usage.totalTokens ?? inputTokens + outputTokens,
      },
    };
  }
}
