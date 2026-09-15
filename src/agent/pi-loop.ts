import { runAgentLoop, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import type { PiModelRuntime } from "./pi-model";

// The bounded tool-loop core shared by the conversational resident agent
// (resident-agent.ts, which has history, idempotency, and persistence) and the
// ephemeral playbook runner (pi-playbook-runner.ts, which has neither). This
// module knows only how to run one Pi agent loop under a turn cap and a
// wall-clock timeout, and how to normalize the outcome — no conversation
// storage, no job-budget policy, no brief writing.

export interface PiLoopUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type PiLoopOutcome =
  | { status: "answered"; answer: string; toolsUsed: string[]; usage: PiLoopUsage; messages: Message[] }
  | { status: "timed_out"; usage: PiLoopUsage }
  | { status: "provider_failed"; message: string; usage: PiLoopUsage }
  | { status: "loop_exhausted"; usage: PiLoopUsage }
  | { status: "empty_answer"; usage: PiLoopUsage };

export interface PiLoopInput {
  runtime: PiModelRuntime;
  model: string;
  systemPrompt: string;
  history: Message[];
  prompt: UserMessage;
  tools: AgentTool[];
  maxTurns: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export async function runBoundedPiLoop(input: PiLoopInput): Promise<PiLoopOutcome> {
  const resolved = input.runtime.resolve(input.model);
  const toolsUsed: string[] = [];
  let turnCount = 0;
  let timedOut = false;
  const abort = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, input.timeoutMs);

  let newMessages: Message[];
  try {
    const completed = await runAgentLoop(
      [input.prompt],
      {
        systemPrompt: input.systemPrompt,
        messages: input.history,
        tools: input.tools,
      },
      {
        model: resolved.model,
        convertToLlm: (messages) => messages.filter(isLlmMessage),
        maxTokens: input.maxOutputTokens,
        toolExecution: "sequential",
        shouldStopAfterTurn: ({ message }) =>
          turnCount >= input.maxTurns && assistantToolCalls(message).length > 0,
      },
      (event) =>
        collectEvent(event, toolsUsed, () => {
          turnCount += 1;
        }),
      abort.signal,
      resolved.stream,
    );
    newMessages = completed.filter(isLlmMessage);
  } catch (error) {
    clearTimeout(timer);
    if (timedOut) {
      return { status: "timed_out", usage: emptyUsage() };
    }
    return {
      status: "provider_failed",
      message: error instanceof Error ? error.message : "The model request failed.",
      usage: emptyUsage(),
    };
  }
  clearTimeout(timer);

  const usage = sumUsage(newMessages);
  const failed = newMessages.find(
    (message): message is AssistantMessage =>
      message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"),
  );
  if (failed) {
    return timedOut
      ? { status: "timed_out", usage }
      : { status: "provider_failed", message: failed.errorMessage ?? "The model request failed.", usage };
  }

  const finalAssistant = [...newMessages].reverse().find(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  if (!finalAssistant || assistantToolCalls(finalAssistant).length > 0) {
    return { status: "loop_exhausted", usage };
  }
  const answer = finalAssistant.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  if (!answer) {
    return { status: "empty_answer", usage };
  }
  return { status: "answered", answer, toolsUsed, usage, messages: sanitizeMessages(newMessages) };
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

function sumUsage(messages: Message[]): PiLoopUsage {
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

function emptyUsage(): PiLoopUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

// Thinking content is internal reasoning scratch; it is never replayed back
// to the model or shown to a caller, so it is stripped before persistence.
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
