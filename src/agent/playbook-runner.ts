import type { Env } from "../runtime/cycle";

// ADR-0031: the seam between the scheduler (who decides *when* a playbook runs)
// and the brain (who runs it). The scheduler never sees Pi types; the brain never
// sees alarms or briefs.

export type PlaybookId = "weekly-plan" | "decompose-assignment" | "forum-brief";

export interface PlaybookRunInput {
  playbook: PlaybookId;
  // What the run is about: an ISO week ("2026-W38") for weekly-plan, "source item_id"
  // for decompose-assignment, the last brief timestamp (ISO) for forum-brief.
  subject?: string;
  // Extra instruction from the caller, appended to the playbook prompt verbatim.
  context?: string;
}

export interface PlaybookUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type PlaybookRunResult =
  | { status: "completed"; title: string; text: string; usage: PlaybookUsage }
  // nothing_to_report: the procedure ran and found nothing worth a brief.
  | { status: "skipped"; reason: "disabled" | "not_configured" | "budget_exhausted" | "nothing_to_report" }
  | { status: "failed"; code: string };

export interface PlaybookRunner {
  run(input: PlaybookRunInput): Promise<PlaybookRunResult>;
}

// Implemented in ./pi-playbook-runner.ts (brain). Declared here so the scheduler
// can be built against the interface.
export type CreatePlaybookRunner = (env: Env) => PlaybookRunner;
