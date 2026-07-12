import type { ItemEvent } from "../kernel/types";

export interface AgentJob {
  id: string;
  enabled: boolean;
  model: string;
  monthlyTokenCap: number;
  lastRunAt: string | null;
}

export interface JobRunInput {
  jobId: string;
  status: "completed" | "failed" | "no_changes";
  output?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  createdAt: string;
}

export interface JobStore {
  get(id: string): Promise<AgentJob | null>;
  getMonthlyUsage(id: string, month: string): Promise<number>;
  recordRun(run: JobRunInput): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

export interface DigestDataSource {
  listRecentEvents(since: string, limit: number): Promise<ItemEvent[]>;
  listUpcoming(days: number, limit: number): Promise<Array<{ title: string; dueAt: string; source: string }>>;
}

export interface TextGeneration {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface TextGenerator {
  generate(input: { model: string; prompt: string; maxOutputTokens: number }): Promise<TextGeneration>;
}

export type DigestResult =
  | { status: "disabled" | "already_ran" | "budget_exhausted" | "no_changes" | "failed" }
  | ({ status: "completed" } & TextGeneration);

export class DailyDigestRunner {
  constructor(
    private readonly store: JobStore,
    private readonly data: DigestDataSource,
    private readonly generator: TextGenerator,
  ) {}

  async run(now = new Date()): Promise<DigestResult> {
    const job = await this.store.get("daily-digest");
    if (!job?.enabled) {
      return { status: "disabled" };
    }
    if (job.lastRunAt?.slice(0, 10) === now.toISOString().slice(0, 10)) {
      return { status: "already_ran" };
    }

    const month = now.toISOString().slice(0, 7);
    const used = await this.store.getMonthlyUsage(job.id, month);
    if (used >= job.monthlyTokenCap) {
      await this.store.setEnabled(job.id, false);
      return { status: "budget_exhausted" };
    }

    const since = job.lastRunAt ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const [events, upcoming] = await Promise.all([
      this.data.listRecentEvents(since, 50),
      this.data.listUpcoming(14, 30),
    ]);
    if (events.length === 0 && upcoming.length === 0) {
      await this.store.recordRun({
        jobId: job.id,
        status: "no_changes",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        createdAt: now.toISOString(),
      });
      return { status: "no_changes" };
    }

    const remaining = job.monthlyTokenCap - used;
    let generated: TextGeneration;
    try {
      generated = await this.generator.generate({
        model: job.model,
        maxOutputTokens: Math.max(1, Math.min(1_500, remaining)),
        prompt: buildPrompt(events, upcoming),
      });
    } catch {
      await this.store.recordRun({
        jobId: job.id,
        status: "failed",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        createdAt: now.toISOString(),
      });
      return { status: "failed" };
    }
    await this.store.recordRun({
      jobId: job.id,
      status: "completed",
      output: generated.text,
      inputTokens: generated.usage.inputTokens,
      outputTokens: generated.usage.outputTokens,
      totalTokens: generated.usage.totalTokens,
      createdAt: now.toISOString(),
    });
    if (used + generated.usage.totalTokens >= job.monthlyTokenCap) {
      await this.store.setEnabled(job.id, false);
    }
    return { status: "completed", ...generated };
  }
}

function buildPrompt(
  events: ItemEvent[],
  upcoming: Array<{ title: string; dueAt: string; source: string }>,
): string {
  return [
    "Write a compact daily digest from the following structured data.",
    "Prioritize deadlines and material changes. Do not invent facts.",
    "Use plain text with short bullets.",
    `Changes: ${JSON.stringify(events)}`,
    `Upcoming: ${JSON.stringify(upcoming)}`,
  ].join("\n");
}
