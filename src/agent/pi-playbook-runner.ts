import type { UserMessage } from "@earendil-works/pi-ai";
import type { JobRunInput, JobStore } from "../jobs/daily-digest";
import { D1JobStore } from "../jobs/d1-job-store";
import { D1McpRepository } from "../mcp/d1-repository";
import type { Env } from "../runtime/cycle";
import { runBoundedPiLoop, type PiLoopUsage } from "./pi-loop";
import { createPiModelRuntime, type PiModelRuntime } from "./pi-model";
import { PLAYBOOKS, type Playbook } from "./playbooks";
import type { PlaybookRunInput, PlaybookRunResult, PlaybookRunner } from "./playbook-runner";
import { buildPlaybookSystemPrompt } from "./prompt";
import { createResidentTools, type AgentToolRepository } from "./tools";

// Same job id, budget, and ledger as the conversational resident agent
// (resident-agent.ts): ADR-0031 meters every Pi call — `ask` turns and
// scheduled playbooks alike — under the one `resident-agent` job.
const JOB_ID = "resident-agent";
const MAX_TURNS = 12;
const MAX_OUTPUT_TOKENS = 1_500;
const TIMEOUT_MS = 50_000;

// The exact line a playbook's procedure instructs the model to emit when it
// finds nothing worth a brief.
const NOTHING_SENTINEL = "NOTHING_TO_REPORT";

export function createPlaybookRunner(env: Env): PlaybookRunner {
  return new PiPlaybookRunner({
    jobs: new D1JobStore(env.DB),
    repository: new D1McpRepository(env.DB),
    runtime: createPiModelRuntime(env),
  });
}

export class PiPlaybookRunner implements PlaybookRunner {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: {
      jobs: JobStore;
      repository: AgentToolRepository;
      runtime: PiModelRuntime | null;
      now?: () => Date;
    },
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async run(input: PlaybookRunInput): Promise<PlaybookRunResult> {
    const playbook = PLAYBOOKS.find((entry) => entry.id === input.playbook);
    if (!playbook) {
      return { status: "failed", code: "unknown_playbook" };
    }

    let job;
    try {
      job = await this.dependencies.jobs.get(JOB_ID);
    } catch {
      return { status: "failed", code: "persistence_failed" };
    }
    if (!job?.enabled) {
      return { status: "skipped", reason: "disabled" };
    }
    if (!this.dependencies.runtime) {
      return { status: "skipped", reason: "not_configured" };
    }
    if (job.currentMonthUsage >= job.monthlyTokenCap) {
      return { status: "skipped", reason: "budget_exhausted" };
    }

    const now = this.now();
    const prompt: UserMessage = {
      role: "user",
      content: buildInstruction(playbook, input),
      timestamp: now.getTime(),
    };

    const outcome = await runBoundedPiLoop({
      runtime: this.dependencies.runtime,
      model: job.model,
      systemPrompt: buildPlaybookSystemPrompt(now),
      history: [],
      prompt,
      tools: createResidentTools(this.dependencies.repository),
      maxTurns: MAX_TURNS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: TIMEOUT_MS,
    });

    if (outcome.status !== "answered") {
      await this.recordRun("failed", outcome.usage, now);
      return { status: "failed", code: outcome.status };
    }

    const answer = outcome.answer.trim();
    if (answer === NOTHING_SENTINEL) {
      await this.recordRun("no_changes", outcome.usage, now);
      return { status: "skipped", reason: "nothing_to_report" };
    }

    await this.recordRun("completed", outcome.usage, now);
    return {
      status: "completed",
      title: buildTitle(playbook, input, now),
      text: answer,
      usage: outcome.usage,
    };
  }

  private async recordRun(status: JobRunInput["status"], usage: PiLoopUsage, now: Date): Promise<void> {
    try {
      await this.dependencies.jobs.recordRun({
        jobId: JOB_ID,
        status,
        ...usage,
        createdAt: now.toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      console.error(JSON.stringify({ event: "playbook_run_ledger_failed", message: message.slice(0, 200) }));
    }
  }
}

function buildInstruction(playbook: Playbook, input: PlaybookRunInput): string {
  const lines = [
    `Playbook: ${playbook.title} (id: ${playbook.id})`,
    `Expected output: ${playbook.output}`,
    "",
    playbook.procedure,
  ];
  if (input.subject) {
    lines.push("", `Subject: ${input.subject}`);
  }
  if (input.context) {
    lines.push("", `Additional context from the caller: ${input.context}`);
  }
  lines.push(
    "",
    `Reply with exactly the single line "${NOTHING_SENTINEL}" and nothing else only when the procedure explicitly says to stop with nothing to report. Otherwise always produce the expected output.`,
  );
  return lines.join("\n");
}

function buildTitle(playbook: Playbook, input: PlaybookRunInput, now: Date): string {
  switch (playbook.id) {
    case "weekly-plan":
      return `Weekly plan · ${input.subject ?? isoWeek(now)}`;
    case "decompose-assignment":
      // input.subject is the assessment's source item id (e.g.
      // "campus-moodle:assessment:123"); a friendlier label would need an
      // extra lookup the runner does not make on the model's behalf.
      return `Plan · ${input.subject ?? "assignment"}`;
    case "forum-brief":
      return `Forum brief · ${formatShortDate(now)}`;
    default:
      return exhaustive(playbook.id);
  }
}

function exhaustive(value: never): never {
  throw new Error(`Unhandled playbook id: ${String(value)}`);
}

function isoWeek(date: Date): string {
  const truncated = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = truncated.getUTCDay() || 7;
  truncated.setUTCDate(truncated.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(truncated.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((truncated.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${truncated.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Formatted by hand rather than via Intl.DateTimeFormat: ICU's "short month"
// data for en-GB has changed between Node/ICU versions (e.g. "Sep" vs
// "Sept"), which would make this title depend on the runtime's ICU version.
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatShortDate(date: Date): string {
  return `${date.getUTCDate()} ${SHORT_MONTHS[date.getUTCMonth()]}`;
}
