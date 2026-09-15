import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type { JobRunInput, JobStore } from "../jobs/daily-digest";
import { runBoundedPiLoop, type PiLoopOutcome } from "./pi-loop";
import type { PiModelRuntime } from "./pi-model";
import { buildConversationSystemPrompt } from "./prompt";
import { createResidentTools, type AgentToolRepository } from "./tools";

const JOB_ID = "resident-agent";
const DEFAULT_HISTORY_LIMIT = 40;
// ADR-0031 raises both: playbook procedures need more tool round-trips than a
// plain lookup, and the wall budget grows with them (55s at the door per
// ADR-0030, minus headroom for HTTP/DO overhead).
export const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;
export const DEFAULT_TIMEOUT_MS = 50_000;

export interface AgentTurn {
  conversationId: string;
  message: string;
  idempotencyKey?: string;
}

export interface AgentTurnResult {
  conversationId: string;
  answer: string;
  toolsUsed: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface ResidentAgent {
  run(turn: AgentTurn): Promise<AgentTurnResult>;
  reset(conversationId: string): Promise<void>;
}

export interface AgentConversationStore {
  loadMessages(conversationId: string, limit?: number): Promise<Message[]>;
  getTurnResult(conversationId: string, idempotencyKey: string): Promise<AgentTurnResult | null>;
  commitTurn(input: AgentTurnCommit): Promise<void>;
  reset(conversationId: string): Promise<void>;
}

export interface AgentTurnCommit {
  conversationId: string;
  messages: Message[];
  idempotencyKey?: string;
  result: AgentTurnResult;
  run: JobRunInput;
}

export type ResidentAgentErrorCode =
  | "invalid_turn"
  | "disabled"
  | "not_configured"
  | "budget_exhausted"
  | "provider_failed"
  | "timed_out"
  | "loop_exhausted"
  | "persistence_failed";

export class ResidentAgentError extends Error {
  constructor(
    readonly code: ResidentAgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResidentAgentError";
  }
}

export class PiResidentAgent implements ResidentAgent {
  private readonly historyLimit: number;
  private readonly maxTurns: number;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: {
      conversations: AgentConversationStore;
      jobs: JobStore;
      repository: AgentToolRepository;
      runtime: PiModelRuntime | null;
      historyLimit?: number;
      maxTurns?: number;
      maxOutputTokens?: number;
      timeoutMs?: number;
      now?: () => Date;
    },
  ) {
    this.historyLimit = dependencies.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.maxTurns = dependencies.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxOutputTokens = dependencies.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = dependencies.now ?? (() => new Date());
  }

  async run(turn: AgentTurn): Promise<AgentTurnResult> {
    const input = normalizeTurn(turn);
    if (input.idempotencyKey) {
      const replay = await this.persisted(() =>
        this.dependencies.conversations.getTurnResult(input.conversationId, input.idempotencyKey!),
      );
      if (replay) {
        return replay;
      }
    }

    const job = await this.persisted(() => this.dependencies.jobs.get(JOB_ID));
    if (!job?.enabled) {
      throw new ResidentAgentError("disabled", "The resident agent is disabled.");
    }
    if (!this.dependencies.runtime) {
      throw new ResidentAgentError("not_configured", "No model credentials are configured.");
    }
    if (job.currentMonthUsage >= job.monthlyTokenCap) {
      throw new ResidentAgentError("budget_exhausted", "The resident agent monthly token cap is exhausted.");
    }

    const history = normalizeHistory(
      await this.persisted(() =>
        this.dependencies.conversations.loadMessages(input.conversationId, this.historyLimit),
      ),
    );
    const userMessage: UserMessage = {
      role: "user",
      content: input.message,
      timestamp: this.now().getTime(),
    };

    const outcome = await runBoundedPiLoop({
      runtime: this.dependencies.runtime,
      model: job.model,
      systemPrompt: buildConversationSystemPrompt(this.now()),
      history,
      prompt: userMessage,
      tools: createResidentTools(this.dependencies.repository),
      maxTurns: this.maxTurns,
      maxOutputTokens: this.maxOutputTokens,
      timeoutMs: this.timeoutMs,
    });

    if (outcome.status !== "answered") {
      await this.recordFailure(outcome.usage);
      throw toResidentAgentError(outcome);
    }

    const result: AgentTurnResult = {
      conversationId: input.conversationId,
      answer: outcome.answer,
      toolsUsed: outcome.toolsUsed,
      usage: outcome.usage,
    };
    const createdAt = this.now().toISOString();
    await this.persisted(() =>
      this.dependencies.conversations.commitTurn({
        conversationId: input.conversationId,
        messages: outcome.messages,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        result,
        run: {
          jobId: JOB_ID,
          status: "completed",
          ...outcome.usage,
          createdAt,
        },
      }),
    );
    return result;
  }

  async reset(conversationId: string): Promise<void> {
    const normalized = normalizeConversationId(conversationId);
    await this.persisted(() => this.dependencies.conversations.reset(normalized));
  }

  private async recordFailure(usage: AgentTurnResult["usage"]): Promise<void> {
    try {
      await this.dependencies.jobs.recordRun({
        jobId: JOB_ID,
        status: "failed",
        ...usage,
        createdAt: this.now().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      console.error(JSON.stringify({ event: "resident_agent_failure_ledger_failed", message: message.slice(0, 200) }));
    }
  }

  private async persisted<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new ResidentAgentError(
        "persistence_failed",
        error instanceof Error ? error.message : "Resident agent persistence failed.",
      );
    }
  }
}

function toResidentAgentError(outcome: Exclude<PiLoopOutcome, { status: "answered" }>): ResidentAgentError {
  switch (outcome.status) {
    case "timed_out":
      return new ResidentAgentError("timed_out", "The resident agent model request timed out.");
    case "loop_exhausted":
      return new ResidentAgentError("loop_exhausted", "The resident agent reached its tool-turn limit.");
    case "empty_answer":
      return new ResidentAgentError("provider_failed", "The model returned no answer.");
    case "provider_failed":
      return new ResidentAgentError("provider_failed", outcome.message);
  }
}

function normalizeTurn(turn: AgentTurn): Required<Pick<AgentTurn, "conversationId" | "message">> & Pick<AgentTurn, "idempotencyKey"> {
  const conversationId = normalizeConversationId(turn.conversationId);
  const message = typeof turn.message === "string" ? turn.message.trim() : "";
  if (!message || message.length > 4_000) {
    throw new ResidentAgentError("invalid_turn", "Message must contain between 1 and 4000 characters.");
  }
  const idempotencyKey = turn.idempotencyKey?.trim();
  if (idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 200)) {
    throw new ResidentAgentError("invalid_turn", "Idempotency key must contain between 1 and 200 characters.");
  }
  return { conversationId, message, ...(idempotencyKey ? { idempotencyKey } : {}) };
}

export function normalizeConversationId(value: unknown): string {
  const conversationId = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9:_-]{1,100}$/.test(conversationId)) {
    throw new ResidentAgentError("invalid_turn", "Conversation id contains unsupported characters.");
  }
  return conversationId;
}

function normalizeHistory(messages: Message[]): Message[] {
  const history = [...messages];
  while (history.length > 0 && history[0]?.role !== "user") {
    history.shift();
  }
  return history;
}
