import type { ItemEvent } from "../kernel/types";
import type { JobStore, TextGenerator, TextGeneration } from "./daily-digest";

// ADR-0023: the resident secretary's one v1 mandate. Deterministic rules decide the
// clear cases with zero LLM; a cheap model judges only the ambiguous middle; the
// result is coalesced into at most one notification. "Never spam" is structural.

export interface TriageItemRef {
  source: string;
  itemId: string;
  title: string;
  kind: string;
}

export interface TriageDataSource {
  listRecentEvents(since: string, limit: number): Promise<ItemEvent[]>;
  describeItems(keys: Array<{ source: string; itemId: string }>): Promise<TriageItemRef[]>;
}

export interface MemoryReader {
  read(): Promise<string>;
}

export type Importance = "important" | "ignore" | "ambiguous";

export interface TriageDecision {
  event: ItemEvent;
  importance: Importance;
  reason: string;
}

export type TriageResult =
  | { status: "disabled" | "budget_exhausted" | "no_changes" }
  | {
      status: "completed";
      important: TriageDecision[];
      notified: boolean;
      usage: TextGeneration["usage"];
      budgetExhausted?: true;
    };

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 100;

export class TriageRunner {
  constructor(
    private readonly store: JobStore,
    private readonly data: TriageDataSource,
    private readonly memory: MemoryReader,
    private readonly generator: TextGenerator | null,
    private readonly notify: (title: string, body: string) => Promise<void>,
  ) {}

  async run(now = new Date()): Promise<TriageResult> {
    const job = await this.store.get("triage");
    if (!job?.enabled) {
      return { status: "disabled" };
    }

    const month = now.toISOString().slice(0, 7);
    const used = await this.store.getMonthlyUsage(job.id, month);
    if (used >= job.monthlyTokenCap) {
      await this.store.setEnabled(job.id, false);
      return { status: "budget_exhausted" };
    }

    const since = job.lastRunAt ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const events = await this.data.listRecentEvents(since, MAX_EVENTS);
    if (events.length === 0) {
      await this.recordNoChanges(job.id, now);
      return { status: "no_changes" };
    }

    const decisions = events.map((event) => classify(event, now));
    const ambiguous = decisions.filter((decision) => decision.importance === "ambiguous");

    let usage: TextGeneration["usage"] = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let budgetExhausted = false;
    if (ambiguous.length > 0 && this.generator) {
      const remaining = job.monthlyTokenCap - used;
      const resolved = await this.judgeAmbiguous(job.model, ambiguous, remaining, now);
      usage = resolved.usage;
      budgetExhausted = used + usage.totalTokens >= job.monthlyTokenCap;
    }

    const important = decisions.filter((decision) => decision.importance === "important");
    let notified = false;
    if (important.length > 0) {
      const refs = await this.data.describeItems(important.map((decision) => decision.event));
      await this.notify("unicorn triage", renderDigest(important, refs));
      notified = true;
    }

    await this.store.recordRun({
      jobId: job.id,
      status: important.length > 0 ? "completed" : "no_changes",
      output: important.length > 0 ? JSON.stringify(important.map((decision) => decision.reason)) : undefined,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      createdAt: now.toISOString(),
    });
    if (budgetExhausted) {
      await this.store.setEnabled(job.id, false);
    }

    return {
      status: "completed",
      important,
      notified,
      usage,
      ...(budgetExhausted ? { budgetExhausted: true as const } : {}),
    };
  }

  private async judgeAmbiguous(
    model: string,
    ambiguous: TriageDecision[],
    remaining: number,
    now: Date,
  ): Promise<{ usage: TextGeneration["usage"] }> {
    const notes = await this.memory.read();
    const prompt = buildTriagePrompt(notes, ambiguous.map((decision) => decision.event));
    const inputCeiling = new TextEncoder().encode(prompt).length + 256;
    if (remaining <= inputCeiling) {
      // No budget headroom for the model: default the ambiguous middle to important
      // rather than silently dropping it — a never-spam secretary must never lose a
      // real change to a budget edge.
      for (const decision of ambiguous) {
        decision.importance = "important";
        decision.reason = "kept: no model budget to triage";
      }
      return { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    }
    let generated: TextGeneration;
    try {
      generated = await this.generator!.generate({
        model,
        prompt,
        maxOutputTokens: Math.min(500, remaining - inputCeiling),
      });
    } catch {
      for (const decision of ambiguous) {
        decision.importance = "important";
        decision.reason = "kept: triage model call failed";
      }
      return { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    }
    applyVerdicts(ambiguous, generated.text);
    void now;
    return { usage: generated.usage };
  }

  private async recordNoChanges(jobId: string, now: Date): Promise<void> {
    await this.store.recordRun({
      jobId,
      status: "no_changes",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      createdAt: now.toISOString(),
    });
  }
}

// Deterministic reflexes (ADR-0023). These never call an LLM.
export function classify(event: ItemEvent, now: Date): TriageDecision {
  if (event.type === "capability.changed") {
    if (event.primitive === "temporal") {
      return { event, importance: "important", reason: "deadline changed" };
    }
    if (event.primitive === "state") {
      return { event, importance: "important", reason: `status changed to ${String(event.after ?? "unknown")}` };
    }
    if (event.primitive === "scalar") {
      return { event, importance: "important", reason: "tracked value changed" };
    }
    return { event, importance: "ambiguous", reason: "relation or actor change" };
  }

  if (event.type === "item.updated") {
    const fields = event.changedFields ?? [];
    const material = fields.filter((field) => field !== "raw");
    if (material.length === 0) {
      return { event, importance: "ignore", reason: "source revision only" };
    }
    return { event, importance: "ambiguous", reason: `updated: ${material.join(", ")}` };
  }

  // item.created: a new item with an imminent deadline is always important; anything
  // else (a new thread, a new course) is for the model to weigh.
  if (isImminentDeadline(event, now)) {
    return { event, importance: "important", reason: "new deadline within 7 days" };
  }
  return { event, importance: "ambiguous", reason: "new item" };
}

function isImminentDeadline(event: ItemEvent, now: Date): boolean {
  if (event.primitive !== "temporal" || typeof event.after !== "string") {
    return false;
  }
  const due = Date.parse(event.after);
  return Number.isFinite(due) && due >= now.getTime() && due - now.getTime() <= SEVEN_DAYS_MS;
}

function buildTriagePrompt(notes: string, events: ItemEvent[]): string {
  return [
    "You are a triage secretary. For each event decide if it is worth interrupting the user.",
    "Default to IGNORE unless it is a staff announcement, a graded result, or a material requirement change.",
    "Respect the user's remembered preferences below; if a note says a course's quizzes don't count, ignore them.",
    "",
    "Preferences and remembered judgments:",
    notes || "(none yet)",
    "",
    "Reply with one line per event as `<itemId>: important` or `<itemId>: ignore`.",
    `Events: ${JSON.stringify(events.map((event) => ({ itemId: event.itemId, source: event.source, type: event.type, changedFields: event.changedFields })))}`,
  ].join("\n");
}

// The model returns `<itemId>: important|ignore` lines. itemIds contain colons
// (e.g. `thread:4`), so match each known id against the text rather than parsing
// generic tokens. Anything the model fails to mention stays important — the safe
// default for a never-miss secretary.
function applyVerdicts(ambiguous: TriageDecision[], text: string): void {
  const lower = text.toLowerCase();
  for (const decision of ambiguous) {
    const id = decision.event.itemId.toLowerCase();
    const pattern = new RegExp(`${escapeRegExp(id)}\\s*:?\\s*(important|ignore)`);
    const verdict = pattern.exec(lower);
    if (verdict?.[1] === "ignore") {
      decision.importance = "ignore";
      decision.reason = "model: not worth interrupting";
    } else {
      decision.importance = "important";
      decision.reason = verdict?.[1] === "important" ? "model: worth interrupting" : "kept: no model verdict";
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderDigest(important: TriageDecision[], refs: TriageItemRef[]): string {
  const titles = new Map(refs.map((ref) => [`${ref.source} ${ref.itemId}`, ref.title]));
  const lines = important.map((decision) => {
    const title = titles.get(`${decision.event.source} ${decision.event.itemId}`) ?? decision.event.itemId;
    return `• ${title} — ${decision.reason}`;
  });
  return lines.join("\n");
}
