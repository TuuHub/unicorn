import { D1JobStore } from "../jobs/d1-job-store";
import { D1McpRepository } from "../mcp/d1-repository";
import type { Env } from "../runtime/cycle";
import { D1AgentConversationStore } from "./d1-conversation-store";
import { OpenAiCompatiblePiRuntime } from "./pi-model";
import { PiResidentAgent, ResidentAgentError, type AgentTurn } from "./resident-agent";

export class AgentSession {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    _state: DurableObjectState,
    private readonly env: Env,
  ) {}

  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/turn") {
      return this.serialized(async () => {
        let turn: AgentTurn;
        try {
          turn = (await request.json()) as AgentTurn;
        } catch {
          return Response.json({ error: "invalid_turn" }, { status: 400 });
        }
        return this.run(turn);
      });
    }
    if (request.method === "DELETE" && url.pathname === "/conversation") {
      return this.serialized(async () => {
        const conversationId = url.searchParams.get("conversationId") ?? "";
        try {
          await this.agent().reset(conversationId);
          return Response.json({ conversationId, reset: true });
        } catch (error) {
          return agentErrorResponse(error);
        }
      });
    }
    return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
  }

  private async run(turn: AgentTurn): Promise<Response> {
    try {
      return Response.json(await this.agent().run(turn));
    } catch (error) {
      if (error instanceof ResidentAgentError) {
        console.error(JSON.stringify({ event: "resident_agent_failed", code: error.code }));
      } else {
        console.error(JSON.stringify({ event: "resident_agent_failed", code: "unknown" }));
      }
      return agentErrorResponse(error);
    }
  }

  private agent(): PiResidentAgent {
    return new PiResidentAgent({
      conversations: new D1AgentConversationStore(this.env.DB),
      jobs: new D1JobStore(this.env.DB),
      repository: new D1McpRepository(this.env.DB),
      runtime: this.env.AI_API_KEY
        ? new OpenAiCompatiblePiRuntime({ apiKey: this.env.AI_API_KEY, baseUrl: this.env.AI_BASE_URL })
        : null,
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.queue.then(operation, operation);
    this.queue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

function agentErrorResponse(error: unknown): Response {
  if (!(error instanceof ResidentAgentError)) {
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
  return Response.json({ error: error.code }, { status: agentErrorStatus(error.code) });
}

function agentErrorStatus(code: ResidentAgentError["code"]): number {
  switch (code) {
    case "invalid_turn":
      return 400;
    case "budget_exhausted":
      return 429;
    case "provider_failed":
    case "loop_exhausted":
      return 502;
    case "timed_out":
      return 504;
    default:
      return 503;
  }
}
