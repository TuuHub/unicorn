import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recordCorrection } from "../corrections";
import type { MemoryStore } from "../memory";
import type { BriefStore } from "../briefs";
import { normalizeConversationId } from "../agent/resident-agent";

const READ_ONLY = { destructiveHint: false, readOnlyHint: true } as const;
const WRITE = { destructiveHint: false, readOnlyHint: false } as const;

// A successful turn mirrors AgentTurnResult minus the conversationId (the client
// supplied it, echoing it back is noise). A failed turn carries only the
// ResidentAgentError code (session.ts already maps it to an HTTP status); the door
// re-maps that code to an MCP tool error instead of an HTTP one.
export interface AgentTurnAnswer {
  answer: string;
  toolsUsed: string[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export type AgentSessionResponse = ({ ok: true } & AgentTurnAnswer) | { ok: false; code: string };

// The seam between the door and the AgentSession Durable Object. index.ts's
// implementation forwards to the DO exactly like POST /agent does; tests supply a
// fake so the four tools are provable without a Durable Object runtime.
export interface AgentSessionClient {
  runTurn(conversationId: string, message: string): Promise<AgentSessionResponse>;
}

export interface DoorDeps {
  agentSessions: AgentSessionClient;
  briefs: BriefStore;
  memory: MemoryStore;
}

// The only guidance a client agent gets (ADR-0030): pull briefs proactively, hand
// every substantive question to `ask` instead of guessing, and use `remember` for
// anything the user corrects unicorn about.
const INSTRUCTIONS = [
  "unicorn is a resident secretary that already knows this user's courses, deadlines, submissions, staff forum posts and email — it does the reasoning, you relay it.",
  "Call get_briefs at the start of a session and whenever the user asks what is new, then call ack_briefs for the ones you show them.",
  "Route every question about courses, deadlines, submissions, forums, email, or planning the week to ask. Never answer those from your own knowledge or invent unicorn's data.",
  "Call remember whenever the user corrects unicorn or states a standing preference about their courses — it is stored verbatim for unicorn's own future reasoning.",
].join("\n");

export function createDoorMcpServer(deps: DoorDeps): McpServer {
  const server = new McpServer({ name: "unicorn-door", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "ask",
    {
      annotations: READ_ONLY,
      description:
        "Ask unicorn about the user's courses, deadlines, submissions, staff forum posts, email, or to plan the week or break down an assignment. Runs one resident-agent turn with tool access to the user's own data and returns a direct answer — never a partial one; a timeout or failure comes back as an error, not a guess.",
      inputSchema: {
        question: z.string().trim().min(1).max(4_000),
        conversationId: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe("Defaults to 'mcp'. Pass your own to keep a separate thread per user or task."),
      },
    },
    async ({ question, conversationId }) => {
      let normalized: string;
      try {
        normalized = normalizeConversationId(conversationId ?? "mcp");
      } catch {
        return jsonError("invalid_turn", "conversationId contains unsupported characters.");
      }
      const response = await deps.agentSessions.runTurn(normalized, question);
      if (!response.ok) {
        return jsonError(response.code, doorErrorMessage(response.code));
      }
      const { answer, toolsUsed, usage } = response;
      return jsonResult({ answer, toolsUsed, usage });
    },
  );

  server.registerTool(
    "get_briefs",
    {
      annotations: READ_ONLY,
      description:
        "List briefs — scheduled weekly plans, assignment breakdowns, staff forum summaries, and daily digests — newest first. Defaults to unread only; call this at the start of a session.",
      inputSchema: {
        unreadOnly: z.boolean().optional().default(true),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
    },
    async ({ unreadOnly, limit }) => jsonResult(await deps.briefs.list({ unreadOnly, limit })),
  );

  server.registerTool(
    "ack_briefs",
    {
      annotations: WRITE,
      description: "Mark briefs as read by id, so get_briefs stops returning them by default.",
      inputSchema: { ids: z.array(z.string().trim().min(1)).min(1) },
    },
    async ({ ids }) => jsonResult({ acknowledged: await deps.briefs.markRead(ids) }),
  );

  server.registerTool(
    "remember",
    {
      annotations: WRITE,
      description:
        'Save a verbatim correction or standing preference for unicorn\'s own future reasoning (e.g. "FIT2099 quizzes don\'t count toward the final grade"). Stored zero-LLM, exactly as written, and read on every future turn.',
      inputSchema: { text: z.string().trim().min(1).max(500) },
    },
    async ({ text }) => jsonResult({ result: await recordCorrection(deps.memory, text) }),
  );

  return server;
}

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function jsonError(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

// Mirrors session.ts's agentErrorStatus mapping, in words instead of HTTP statuses.
function doorErrorMessage(code: string): string {
  switch (code) {
    case "invalid_turn":
      return "The question was invalid.";
    case "disabled":
      return "The resident agent is disabled.";
    case "not_configured":
      return "The resident agent has no model credentials configured.";
    case "budget_exhausted":
      return "The resident agent has reached its monthly token cap.";
    case "provider_failed":
      return "The model request failed.";
    case "timed_out":
      return "The request timed out.";
    case "loop_exhausted":
      return "The resident agent reached its tool-turn limit without answering.";
    case "persistence_failed":
      return "Saving the conversation failed.";
    default:
      return "The request could not be completed.";
  }
}
