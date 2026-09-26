import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recordCorrection } from "../corrections";
import type { MemoryStore } from "../memory";
import type { BriefStore } from "../briefs";
import { registerUserTools } from "../tools/user-tools";

const READ_ONLY = { destructiveHint: false, readOnlyHint: true } as const;
const WRITE = { destructiveHint: false, readOnlyHint: false } as const;

export interface DoorDeps {
  briefs: BriefStore;
  memory: MemoryStore;
  // D1 handle for the ADR-0035 user-defined tools registered below. Optional
  // so existing callers/tests that don't touch D1 keep working unchanged;
  // production always supplies it (see src/index.ts).
  db?: D1Database;
}

// ADR-0034: unicorn does no reasoning itself now — it is a memory layer the
// client's own agent reads. get_briefs/ack_briefs surface what unicorn has
// already prepared (digests, and later scheduled playbook output); remember
// captures corrections for unicorn's own future structured output.
const INSTRUCTIONS = [
  "unicorn is a memory layer: it ingests this user's courses, deadlines, submissions, staff forum posts and email and keeps them structured. It does not reason about them — you do, from what these tools return.",
  "Call get_briefs at the start of a session and whenever the user asks what is new, then call ack_briefs for the ones you show them.",
  "Call remember whenever the user corrects unicorn or states a standing preference about their courses — it is stored verbatim for unicorn's own future structured output.",
].join("\n");

// Async because registering ADR-0035 user tools means re-listing user_tools
// from D1 before the server starts handling requests — see the marked call
// below. Every caller already awaits somewhere in the same async function
// (src/index.ts's fetch handler, tests/mcp-door.test.ts's connectClient), so
// this stays a one-line ripple, not a redesign.
export async function createDoorMcpServer(deps: DoorDeps): Promise<McpServer> {
  const server = new McpServer({ name: "unicorn-door", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get_briefs",
    {
      annotations: READ_ONLY,
      description:
        "List briefs — daily digests, and later scheduled playbook output — newest first. Defaults to unread only; call this at the start of a session.",
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
        'Save a verbatim correction or standing preference for unicorn\'s own future structured output (e.g. "FIT2099 quizzes don\'t count toward the final grade"). Stored zero-LLM, exactly as written.',
      inputSchema: { text: z.string().trim().min(1).max(500) },
    },
    async ({ text }) => jsonResult({ result: await recordCorrection(deps.memory, text) }),
  );

  // user-defined tools (ADR-0035) are registered here
  if (deps.db) {
    await registerUserTools(server, { db: deps.db });
  }

  return server;
}

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
