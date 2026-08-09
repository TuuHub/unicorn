import { runAgentLoop, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import type { JobRunInput, JobStore } from "../jobs/daily-digest";
import type { PiModelRuntime } from "./pi-model";
import { createResidentTools, type AgentToolRepository } from "./tools";

const JOB_ID = "resident-agent";
const DEFAULT_HISTORY_LIMIT = 40;
const DEFAULT_MAX_TURNS = 4;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;
const DEFAULT_TIMEOUT_MS = 20_000;

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
  commitTurn(input: {
    conversationId: string;
    messages: Message[];
    idempotencyKey?: string;
    result: AgentTurnResult;
    run: JobRunInput;
  }): Promise<void>;
  reset(conversationId: string): Promise<void>;
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
    const resolved = this.dependencies.runtime.resolve(job.model);
    const userMessage: UserMessage = {
      role: "user",
      content: input.message,
      timestamp: this.now().getTime(),
    };
    const toolsUsed: string[] = [];
    let turnCount = 0;
    let timedOut = false;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeoutMs);

    let newMessages: Message[];
    try {
      const completed = await runAgentLoop(
        [userMessage],
        {
          systemPrompt: systemPrompt(this.now()),
          messages: history,
          tools: createResidentTools(this.dependencies.repository),
        },
        {
          model: resolved.model,
          convertToLlm: (messages) => messages.filter(isLlmMessage),
          maxTokens: this.maxOutputTokens,
          toolExecution: "sequential",
          shouldStopAfterTurn: ({ message }) =>
            turnCount >= this.maxTurns && assistantToolCalls(message).length > 0,
        },
        (event) => collectEvent(event, toolsUsed, () => {
          turnCount += 1;
        }),
        abort.signal,
        resolved.stream,
      );
      newMessages = completed.filter(isLlmMessage);
    } catch (error) {
      await this.recordFailure(emptyUsage());
      if (timedOut) {
        throw new ResidentAgentError("timed_out", "The resident agent model request timed out.");
      }
      throw new ResidentAgentError(
        "provider_failed",
        error instanceof Error ? error.message : "The resident agent model request failed.",
      );
    } finally {
      clearTimeout(timer);
    }

    const usage = sumUsage(newMessages);
    const failed = newMessages.find(
      (message): message is AssistantMessage =>
        message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"),
    );
    if (failed) {
      await this.recordFailure(usage);
      throw new ResidentAgentError(
        timedOut ? "timed_out" : "provider_failed",
        timedOut ? "The resident agent model request timed out." : (failed.errorMessage ?? "The model request failed."),
      );
    }

    const finalAssistant = [...newMessages].reverse().find(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    if (!finalAssistant || assistantToolCalls(finalAssistant).length > 0) {
      await this.recordFailure(usage);
      throw new ResidentAgentError("loop_exhausted", "The resident agent reached its tool-turn limit.");
    }
    const answer = finalAssistant.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    if (!answer) {
      await this.recordFailure(usage);
      throw new ResidentAgentError("provider_failed", "The model returned no answer.");
    }

    const result: AgentTurnResult = {
      conversationId: input.conversationId,
      answer,
      toolsUsed,
      usage,
    };
    const createdAt = this.now().toISOString();
    await this.persisted(() =>
      this.dependencies.conversations.commitTurn({
        conversationId: input.conversationId,
        messages: sanitizeMessages(newMessages),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        result,
        run: {
          jobId: JOB_ID,
          status: "completed",
          ...usage,
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

function normalizeConversationId(value: string): string {
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

function isLlmMessage(message: AgentMessage): message is Message {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function collectEvent(event: AgentEvent, toolsUsed: string[], onTurn: () => void): void {
  if (event.type === "turn_start") {
    onTurn();
  }
  if (event.type === "tool_execution_start" && !toolsUsed.includes(event.toolName)) {
    toolsUsed.push(event.toolName);
  }
}

function assistantToolCalls(message: AssistantMessage) {
  return message.content.filter((part) => part.type === "toolCall");
}

function sumUsage(messages: Message[]): AgentTurnResult["usage"] {
  const usage = emptyUsage();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    usage.inputTokens += message.usage.input;
    usage.outputTokens += message.usage.output;
    usage.totalTokens += message.usage.totalTokens;
  }
  return usage;
}

function emptyUsage(): AgentTurnResult["usage"] {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function sanitizeMessages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    return {
      ...message,
      content: message.content.filter((part) => part.type !== "thinking"),
    };
  });
}

function systemPrompt(now: Date): string {
  return [
    "You are Unicorn, a concise single-user resident secretary.",
    `Current UTC time: ${now.toISOString()}.`,
    "Use the read-only Unicorn tools before making claims about current items, deadlines, changes, memory, or sync state.",
    "Treat tool results as authoritative. Say when data is absent or stale. Never invent source state.",
    "Do not claim to perform writes, synchronization, browsing, shell commands, or secret access.",
    "Answer the user's question directly and briefly.",
  ].join("\n");
}
