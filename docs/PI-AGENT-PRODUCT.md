# Pi resident agent product contract

> **Historical.** This document describes the in-Worker Pi resident agent — `POST /agent`,
> Telegram, BYOK/Workers AI model calls, the `resident-agent` job. ADR-0034 removed all of it:
> unicorn runs no model and calls no LLM provider. Reasoning now runs in the student's own
> harness (Claude Code, claude.ai, ChatGPT, Cowork) against the door (`docs/ARCHITECTURE.md`
> §7, `docs/ADR.md` ADR-0034). Kept here for the design trail; nothing below describes current
> code.

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

Every tool is read-only against sources; the only writes are to the agent's own `plans` and `memory` tables (ADR-0031). List/search tools return clipped, bounded projections; `get_item` is the one tool that returns a full, unclipped body, and only for a specifically requested item.

- `list_courses` — every known course across platforms (Moodle, Ed), with unit code and status.
- `get_course_overview(course)` — one course's assessments, staff/pinned Ed posts, email mentions, and which sources (`moodle`, `ed`, `ontrack`, `email`) actually have data for it. `ontrack` is reported `false` today: no OnTrack plugin exists yet.
- `search_items(query, kind?, course?, since?, limit?)` — free-text search over item titles/bodies, optionally scoped to a kind, a course, or a recency window.
- `get_item(source, itemId)` — one item's full body, uncapped.
- `list_upcoming` — items with an upcoming deadline capability.
- `list_changes` — recent kernel change events.
- `list_staff_posts(course?, since?, limit?)` — Ed threads authored by teaching staff, or that are platform announcements or pinned.
- `list_memory` — the agent's own memory notes (corrections, preferences).
- `get_sync_status` — the last ingestion cycle's summary.
- `get_plan(kind, subject)` / `save_plan(kind, subject, content)` — read/write a saved plan (see Plans below).
- `remember(text)` — record a verbatim correction, the same inbox `/remember` and IM corrections use.

There is no arbitrary fetch, SQL, shell, code execution, source synchronization, plugin installation, relation write, settings write, or secret access in the Pi tool set.

## Playbooks and plans

A **playbook** is a named, human-authored procedure — `weekly-plan`, `decompose-assignment`, `forum-brief` — that tells the agent what to check and how, using only the tools above. Playbooks are markdown source (`src/agent/playbooks/*.md`), each with an `id`/`title`/`trigger`/`output` header and a numbered procedure written for a real Monash student (unit codes, Moodle submission status, Ed staff/announcement/pinned posts, email `course-mention`s, and an explicit "not connected" answer when a source like OnTrack is absent). `npm run playbooks:build` compiles them into `src/agent/playbooks.ts`; `tests/playbooks-sync.test.ts` fails `npm run check` if the generated file drifts from the markdown.

The conversational system prompt embeds all three procedures compactly, so `/agent` and Telegram conversation can run them inline. A separate `PlaybookRunner` (`src/agent/pi-playbook-runner.ts`, `createPlaybookRunner(env)`) runs one playbook **outside** any conversation — no history, same tools, same `resident-agent` job budget and ledger — for scheduled or triggered use. It returns:

- `{status: "completed", title, text, usage}` — a short human-readable result;
- `{status: "skipped", reason: "nothing_to_report"}` — the playbook's procedure ends by instructing the model to emit a fixed sentinel line when there is nothing worth reporting, which the runner recognizes instead of returning an empty brief;
- `{status: "skipped", reason: "disabled" | "not_configured" | "budget_exhausted"}` — same gating as a normal turn, checked before any inference call;
- `{status: "failed", code}` — timeout, provider failure, loop exhaustion, empty answer, an unknown playbook id, or a job-store failure.

A **plan** is a saved per-subject text artifact — a weekly plan keyed by ISO week (e.g. `2026-W38`), or an assignment plan keyed by the assessment's item id — written with `save_plan` and re-read with `get_plan`. Plans live in the `plans` D1 table (`migrations/0009_plans.sql`), one row per `(kind, subject)`, upserted on every save so re-planning replaces rather than duplicates.

A **brief** is the short text a playbook run hands back (e.g. forum-brief's summary of new staff posts); it is not itself persisted unless the caller separately saves it as a plan.

## Reliability and cost

- The `resident-agent` job has its own enable flag, model, monthly token cap, and measured run ledger.
- A turn is rejected before inference when the job is disabled, no model runtime exists, or the monthly cap is exhausted.
- The native Workers AI binding is the zero-secret default. An `AI_API_KEY` plus optional `AI_BASE_URL` overrides it for OpenAI-compatible BYOK deployments.
- Provider errors, aborts, empty responses, tool-loop limits, and persistence failures are explicit failures; none are rendered as a successful answer.
- A model failure never affects ingestion, deterministic triage, retention, scheduling, MCP, or notification delivery.
- Model calls have a hard timeout and bounded output. Tool execution is sequential and the turn count is capped: 12 turns, 50-second timeout (`DEFAULT_MAX_TURNS` / `DEFAULT_TIMEOUT_MS` in `src/agent/resident-agent.ts`, shared by conversation turns and playbook runs alike).

## Security and privacy

- `/agent` uses the existing constant-time bearer-token check.
- Telegram continues to verify the webhook secret and owner chat id before reading message content.
- Prompts receive compact projections, not unrestricted raw rows. `get_item` is available only for a specifically requested item.
- Logs contain counts and error codes, never prompts, answers, memory contents, source bodies, credentials, or Telegram text.
- BYOK and Telegram secrets stay in Cloudflare Worker Secrets and are never persisted in D1. Native Workers AI uses a binding, not a model credential.

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
