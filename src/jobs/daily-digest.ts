import type { ItemEvent } from "../kernel/types";
import { estimateTokens } from "../memory";

export interface AgentJob {
  id: string;
  enabled: boolean;
  model: string;
  monthlyTokenCap: number;
  scheduleHourUtc: number;
  credentialPreference: "byok";
  currentMonthUsage: number;
  projectedMonthlyTokens: number;
  lastRunAt: string | null;
}

export interface AgentJobConfig {
  enabled: boolean;
  model: string;
  monthlyTokenCap: number;
  scheduleHourUtc: number;
  credentialPreference: "byok";
}

export interface JobRunInput {
  jobId: string;
  status: "completed" | "failed" | "no_changes";
  output?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  createdAt: string;
  // Where the job's since-window should resume. Defaults to createdAt; triage sets
  // it to the newest processed event when a window overflows its cap so the next
  // cycle continues from there instead of dropping the overflow.
  watermark?: string;
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
  | { status: "disabled" | "not_due" | "already_ran" | "budget_exhausted" | "no_changes" | "failed" }
  | ({ status: "completed"; budgetExhausted?: true } & TextGeneration);

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
    if (now.getUTCHours() < job.scheduleHourUtc) {
      return { status: "not_due" };
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

    const prompt = buildPrompt(events, upcoming);
    const remaining = job.monthlyTokenCap - used;
    const inputTokenCeiling = estimateInputTokenCeiling(prompt);
    if (remaining <= inputTokenCeiling) {
      await this.store.setEnabled(job.id, false);
      return { status: "budget_exhausted" };
    }
    let generated: TextGeneration;
    try {
      generated = await this.generator.generate({
        model: job.model,
        maxOutputTokens: Math.min(1_500, remaining - inputTokenCeiling),
        prompt,
      });
    } catch (error) {
      // Persist the failure cause in the run row (surfaced by list_agent_job_runs)
      // so a broken key/model/base-url is diagnosable without log spelunking.
      const message = error instanceof Error ? error.message : String(error);
      await this.store.recordRun({
        jobId: job.id,
        status: "failed",
        output: `model call failed: ${message.slice(0, 500)}`,
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
    const budgetExhausted = used + generated.usage.totalTokens >= job.monthlyTokenCap;
    if (budgetExhausted) {
      await this.store.setEnabled(job.id, false);
    }
    return { status: "completed", ...generated, ...(budgetExhausted ? { budgetExhausted: true as const } : {}) };
  }
}

// Reserve input budget with the shared CJK-aware token estimate plus headroom.
// The previous byte-count reservation overstated Latin prompts ~4x, which both
// tripped the budget gate far too early and crushed maxOutputTokens.
function estimateInputTokenCeiling(prompt: string): number {
  return estimateTokens(prompt) + 256;
}

function buildPrompt(
  events: ItemEvent[],
  upcoming: Array<{ title: string; dueAt: string; source: string }>,
): string {
  // Compact projections, not raw rows: event UUIDs are meaningless to the model and
  // before/after payloads can be arbitrarily large, so both are stripped or clipped.
  const changes = events.map((event) => ({
    item: event.itemId,
    source: event.source,
    type: event.type,
    ...(event.capability ? { capability: event.capability } : {}),
    ...(event.changedFields?.length ? { fields: event.changedFields.filter((field) => field !== "raw") } : {}),
    ...(event.after !== undefined ? { after: clipValue(event.after) } : {}),
  }));
  return [
    "Write a compact daily digest from the following structured data.",
    "Prioritize deadlines and material changes. Do not invent facts.",
    "Use plain text with short bullets.",
    `Changes: ${JSON.stringify(changes)}`,
    `Upcoming: ${JSON.stringify(upcoming)}`,
  ].join("\n");
}

function clipValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
