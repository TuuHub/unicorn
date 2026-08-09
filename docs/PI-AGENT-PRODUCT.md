# Pi resident agent product contract

## Outcome

unicorn is a single-user resident secretary running on one Cloudflare Worker. It keeps the deterministic ingestion kernel as its source of truth and uses Pi only for bounded conversational reasoning over that truth.

The first complete Pi-backed product has two conversation surfaces:

- `POST /agent`, protected by `ADMIN_TOKEN`, for operator and integration use.
- Telegram text messages from the configured owner chat.

Both surfaces use the same conversation runtime and the same persisted history.

## Product behavior

### Conversation

- A user can ask about upcoming deadlines, recent changes, stored items, remembered preferences, and the last synchronization cycle.
- The resident agent uses tools before making claims about current data. It never invents source state.
- Conversation history survives Worker eviction and deployment.
- A bounded recent-history window is loaded for each turn. Old rows remain auditable but do not grow prompts without limit.
- Replaying the same idempotency key returns the stored answer without spending tokens or appending duplicate messages.
- Only one turn runs at a time for a conversation. Cloudflare Durable Object routing provides that coordination.

### Telegram commands

- `/start` and `/help` explain the product.
- `/remember <text>` records a correction verbatim for future reasoning and triage.
- `/memory` shows the current correction note.
- `/reset` clears conversational history without deleting world state or memory notes.
- Other owner text is handled as a resident-agent turn.

### HTTP interface

`POST /agent` accepts JSON:

```json
{
  "message": "What matters today?",
  "conversationId": "operator",
  "idempotencyKey": "optional-caller-key"
}
```

It returns the conversation id, answer, tools used, and measured token usage. `DELETE /agent?conversationId=operator` clears only that conversation.

## Runtime interface

The external seam is deliberately small:

```ts
interface ResidentAgent {
  run(turn: AgentTurn): Promise<AgentTurnResult>;
  reset(conversationId: string): Promise<void>;
}
```

Pi message types, provider routing, event handling, tool schemas, replay conversion, and error semantics remain inside the implementation. Callers see domain results and stable error categories.

## Tools

The first version is read-only. It exposes compact projections for:

- upcoming items;
- recent changes;
- normalized item lists and individual items;
- agent memory;
- latest synchronization status.

There is no arbitrary fetch, SQL, shell, code execution, source synchronization, plugin installation, relation write, settings write, or secret access in the Pi tool set.

## Reliability and cost

- The `resident-agent` job has its own enable flag, model, monthly token cap, and measured run ledger.
- A turn is rejected before inference when the job is disabled, no model credentials exist, or the monthly cap is exhausted.
- Provider errors, aborts, empty responses, tool-loop limits, and persistence failures are explicit failures; none are rendered as a successful answer.
- A model failure never affects ingestion, deterministic triage, retention, scheduling, MCP, or notification delivery.
- Model calls have a hard timeout and bounded output. Tool execution is sequential and the turn count is capped.

## Security and privacy

- `/agent` uses the existing constant-time bearer-token check.
- Telegram continues to verify the webhook secret and owner chat id before reading message content.
- Prompts receive compact projections, not unrestricted raw rows. `get_item` is available only for a specifically requested item.
- Logs contain counts and error codes, never prompts, answers, memory contents, source bodies, credentials, or Telegram text.
- Secrets stay in Cloudflare Worker Secrets and are never persisted in D1.

## Acceptance criteria

1. Existing ingestion, triage, digest, memory, MCP, settings, scheduler, and notifier tests remain green.
2. Pi replaces Vercel AI SDK behind the existing `TextGenerator` seam without behavior changes.
3. A resident-agent test proves a persisted follow-up turn can use prior conversation.
4. A tool-loop test proves the agent can query real repository behavior and answer from the result.
5. A repeated idempotency key returns the previous result with no second model run.
6. Provider failure and budget exhaustion are observable failures with no persisted assistant message.
7. Telegram command and conversation behavior is covered through the webhook interface.
8. Wrangler dry-run succeeds with the Pi bundle and `nodejs_compat`.
9. Remote D1 migration, production deploy, authenticated `/agent` smoke, and existing `/health` smoke succeed.

## Non-goals

- Cloudflare OS Gadgets, Gatekeepers, Dynamic Workers, Code Mode, arbitrary code execution, or multi-user workspaces.
- Autonomous writes to source systems.
- Vector memory, unbounded chat history, or an always-running daemon.
- Replacing the Unicorn kernel, plugin model, MCP surface, scheduler, D1 world state, or outbox.
