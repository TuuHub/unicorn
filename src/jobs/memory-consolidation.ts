import {
  estimateTokens,
  MEMORY_TOKEN_CAP,
  MemoryConflictError,
  type MemoryNote,
  type MemoryStore,
} from "../memory";
import type { JobStore, TextGenerator, TextGeneration } from "./daily-digest";

// ADR-0024's forced-forgetting hygiene, run by the resident agent: when the notes
// approach the hard cap, one budget-capped model call rewrites them tighter. It
// only compresses — merging duplicates and dropping obsolete rules — and never
// invents judgments. New judgments still enter exclusively through the user's own
// MCP client (update_memory); the resident loop has no correction signal to learn
// from until the IM conversational face exists.

// Consolidate before writes start failing at the hard cap...
export const CONSOLIDATION_THRESHOLD = Math.floor(MEMORY_TOKEN_CAP * 0.8);
// ...and compress well below the threshold so it doesn't re-trigger immediately.
const TARGET_TOKENS = Math.floor(MEMORY_TOKEN_CAP * 0.6);

export type ConsolidationResult =
  | { status: "not_needed" | "no_model" | "triage_not_ready" | "no_budget" | "failed" }
  | { status: "completed"; beforeTokens: number; afterTokens: number; usage: TextGeneration["usage"] };

export class MemoryConsolidator {
  constructor(
    private readonly memory: MemoryStore,
    private readonly jobs: JobStore,
    private readonly generator: TextGenerator | null,
  ) {}

  async run(now = new Date()): Promise<ConsolidationResult> {
    const notes = (await this.memory.list()).filter((note) => note.content.trim());
    const beforeTokens = notes.reduce((sum, note) => sum + estimateTokens(note.content), 0);
    if (beforeTokens < CONSOLIDATION_THRESHOLD) {
      return { status: "not_needed" };
    }
    if (!this.generator) {
      return { status: "no_model" };
    }
    // The triage job pays for consolidation (memory exists to serve its judge), so
    // it must be enabled. lastRunAt must exist because recordRun would otherwise
    // initialize the triage watermark to now and skip its 24h backfill window.
    const job = await this.jobs.get("triage");
    if (!job?.enabled || !job.lastRunAt) {
      return { status: "triage_not_ready" };
    }
    const month = now.toISOString().slice(0, 7);
    const used = await this.jobs.getMonthlyUsage(job.id, month);
    const prompt = buildConsolidationPrompt(notes);
    const inputCeiling = estimateTokens(prompt) + 256;
    const outputCeiling = TARGET_TOKENS + 256;
    if (job.monthlyTokenCap - used <= inputCeiling + outputCeiling) {
      return { status: "no_budget" };
    }

    let generated: TextGeneration;
    try {
      generated = await this.generator.generate({ model: job.model, prompt, maxOutputTokens: outputCeiling });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "memory_consolidation_failed", message: message.slice(0, 300) }));
      return { status: "failed" };
    }

    const rewritten = parseSections(generated.text);
    // Safety rails: the model may only shrink existing domains. A missing or grown
    // section keeps the original — consolidation must never lose or add judgments
    // beyond compression.
    let afterTokens = 0;
    const writes: Array<{ note: MemoryNote; content: string }> = [];
    for (const note of notes) {
      const next = rewritten.get(note.domain);
      const keepOriginal = next === undefined || estimateTokens(next) >= estimateTokens(note.content);
      afterTokens += estimateTokens(keepOriginal ? note.content : next!);
      if (!keepOriginal) {
        writes.push({ note, content: next! });
      }
    }
    if (writes.length === 0 || afterTokens >= beforeTokens) {
      await this.recordRun(job.id, job.lastRunAt, generated.usage, `memory consolidation ineffective: ${beforeTokens} tokens`, now);
      return { status: "failed" };
    }

    for (const { note, content } of writes) {
      try {
        // Optimistic concurrency: if the user's client rewrote this domain since we
        // read it, their judgment wins and this domain waits for the next pass.
        await this.memory.save(note.domain, content, note.updatedAt);
      } catch (error) {
        if (!(error instanceof MemoryConflictError)) {
          throw error;
        }
      }
    }
    await this.recordRun(job.id, job.lastRunAt, generated.usage, `memory consolidated: ${beforeTokens} -> ${afterTokens} tokens`, now);
    return { status: "completed", beforeTokens, afterTokens, usage: generated.usage };
  }

  // Books the tokens against the triage monthly cap and surfaces the action in
  // list_agent_job_runs, while pinning the watermark so the triage event window
  // is untouched.
  private recordRun(
    jobId: string,
    watermark: string,
    usage: TextGeneration["usage"],
    output: string,
    now: Date,
  ): Promise<void> {
    return this.jobs.recordRun({
      jobId,
      status: "completed",
      output,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      createdAt: now.toISOString(),
      watermark,
    });
  }
}

function buildConsolidationPrompt(notes: MemoryNote[]): string {
  const sections = notes.map((note) => `## ${note.domain}\n${note.content}`).join("\n\n");
  return [
    "You maintain the memory notes of a triage secretary. They exceed their size budget.",
    "Rewrite them tighter: merge duplicate judgments, drop obsolete rules (ended courses, past deadlines), keep one line per rule.",
    "Preserve every distinct current judgment and keep the user's wording where possible.",
    "Do NOT invent, reinterpret, or add anything.",
    `Keep the exact section structure — one "## <domain>" header per section, same domains.`,
    `The total result must be under ${TARGET_TOKENS} tokens.`,
    "",
    sections,
  ].join("\n");
}

// Parse "## domain" sections back out of the model reply.
function parseSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const matches = [...text.matchAll(/^##\s+([a-z0-9][a-z0-9-]{0,62})\s*$/gim)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const start = match.index! + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : text.length;
    sections.set(match[1]!.toLowerCase(), text.slice(start, end).trim());
  }
  return sections;
}
