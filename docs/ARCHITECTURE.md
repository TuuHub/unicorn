# unicorn — Architecture (end-state)

This describes the whole system in its intended final form, from zero. It's the synthesized picture; the decision trail and rationale live in [ADR.md](ADR.md), the vocabulary in [GLOSSARY.md](GLOSSARY.md). When this doc and an ADR disagree, the ADR is authoritative (it records *why*); fix this doc.

Rewritten 2026-09-21 for ADR-0034 – ADR-0038; updated 2026-09-27 for the amendments in ADR-0039–0044. Section 13 is a status list, not a build order — everything in it is shipped.

---

## 1. What unicorn is, in one paragraph

unicorn is the **memory layer of a student's own AI agent**: a single Cloudflare Worker on the student's own free account that ingests their campus sources (Ed, Moodle, Canvas, Gmail) every hour, remembers what they looked like, joins one course across every system, and hands the result to whatever agent the student already runs — Claude Code, claude.ai on a phone, ChatGPT, Cowork — through one MCP door with widgets. It has **no model of its own** (ADR-0034). Thinking happens in the client, interactively or on a schedule; unicorn remembers, connects, notices change, and draws.

The rule that settles every "why not just mount the source in Claude": **a source mounted in the client is live; the same source ingested by unicorn is memory. Both at once is the design.** A client with every source mounted still cannot answer "what changed since Tuesday", cannot see that one course lives in three systems, cannot share a plan between a laptop session and a phone session, and cannot show a card instead of a paragraph. Those four are the product.

---

## 2. The shape: one Worker, a body, a door, and the harness around it

```
   the student's harness (not our code)                    ONE CLOUDFLARE WORKER (ours)
 ┌──────────────────────────────────────────┐    ┌──────────────────────────────────────────────┐
 │ Claude Code · claude.ai · ChatGPT · Cowork│    │                                              │
 │                                          │    │  hourly alarm ──▶ Plugins ──▶ KERNEL          │
 │  live sources mounted directly:          │    │   (Ed, Moodle, Canvas,      Item + facets     │
 │   Ed MCP · Moodle MCP · canvas-mcp · Gmail│    │    Gmail, RSS, any MCP)     diff → Events v2  │
 │                                          │    │                             buckets           │
 │  playbooks as MCP prompts / skills       │    │                             course resolver   │
 │  routines: weekly-plan, decompose,       │    │                             daily digest      │
 │            forum-brief, triage           │◀──▶│                             retention         │
 │  SessionStart hook: pull briefs          │    │                                  │            │
 │  widgets rendered from ui:// resources   │    │                             ┌────▼────┐       │
 └──────────────────────────────────────────┘    │                             │   D1    │       │
              ▲ OAuth / bearer                   │                             └────┬────┘       │
              │                                  │        ┌─────────────────────────┼─────┐      │
              ▼                                  │   ┌────▼────┐  ┌──────────┐  ┌───▼───┐ │      │
      the student (operator)                     │   │  door   │  │  admin   │  │/settings│      │
      ───────────────────────────────────────────┼──▶│  /mcp   │  │/mcp/admin│  │onboard │      │
                                                 │   └─────────┘  └──────────┘  └────────┘      │
                                                 └──────────────────────────────────────────────┘
```

- **Kernel** — the source-agnostic body. Owns the Item + facet model, change detection, buckets, the course resolver, the zero-LLM daily digest, retention, the scheduler. No model, no outbound push.
- **Plugins** — bring sources. Ingestion-only (ADR-0018): fetch and map to Items and facets, nothing downstream.
- **Door** (`/mcp`) — the one surface a client agent mounts: state tools, MCP prompts, widgets, user-defined tools (ADR-0035, ADR-0037).
- **Admin** (`/mcp/admin`) — operator tools for the student or their coding agent: sources, links, tool definitions, inspection.
- **`/settings`** — the only web page: onboarding by source, OAuth consent, timezone, sync status. It is not a dashboard; anything about reading data belongs to the agent.
- **Harness** — the client, its scheduler, and the plugin we ship for it. Playbooks run there. That is where reasoning lives.

---

## 3. The data model: generic Item + typed facets + a bucket

(ADR-0016, ADR-0036) Every record is a **generic Item**. Plugins optionally attach **typed facets**; facets optionally declare **capabilities** that bind fields to behavior **primitives** (ADR-0019/0020). ADR-0036 adds a bucket path to every Item.

```
Item {
  id, source, kind, title, timestamp, url, body, raw
  bucket       # "course/FIT3175/assignment-2" | "course/FIT3175/general" | "life/events" | "life/admin" | "life/other" | null
  topic        # optional free label from triage ("exam", "release", "club", …)
  labeled_by   # "structure" | "triage" | "client" | null
  facets[]
}

Facet { type, data, capabilities[] }

course-identity facet { code, term, title }     # term is new; Canvas and Ed supply it, Moodle parses shortname
```

### Behavior primitives — the finite kernel surface

Unchanged (ADR-0020). Capabilities bind onto five primitives: `temporal`, `state`, `relation`, `actor`, `scalar`. A new domain need is a declaration, not a kernel change. The primitives are what turn a field diff into a typed event in section 6.

### Course identity across sources

One course exists in Moodle, Ed, Canvas and mail under different ids. The **course resolver** (ADR-0036) answers "which Items are FIT3175", first hit wins:

1. a confirmed relation (`link_items`, admin);
2. exact match on the normalised code (`normalizeCourseCode`, `src/kernel/courses.ts`), with `term` when both sides carry one, else the current active offering;
3. nothing automatic beyond that: an item the resolver can't place is returned `unlabeled`, and the harness files it with `label_items` during triage (`suggest_links` was dropped, ADR-0045).

Assessment ↔ Ed category uses the same ladder on normalised titles (`matchCategoryToAssessment`): exact slug match, else a unique word-boundary prefix match, else null — never a guess between two equally-good candidates. Ambiguity is returned, never resolved by guessing.

---

## 4. The ingestion lifecycle

One scheduler cycle, hourly, a self-renewing Durable Object alarm (ADR-0021):

1. **Fetch** — each enabled plugin pulls its source with its own auth.
2. **Normalize** — plugin maps payload → Items + facets. Tier-1 runs a manifest; Tier-2 runs code.
3. **Diff** — kernel compares against the stored Item.
4. **Events** — differences become typed events (section 6), each with a monotonic id that doubles as the client cursor.
5. **Label** — structured Items get their bucket deterministically: an assessment owns its bucket; an Ed thread joins the assessment bucket its category matches, else `general`. Free text stays unlabelled until the triage routine runs.
6. **Digest** — once a day at the user's local 07:00, if anything happened: a brief listing changes since the last digest, deadlines in 7 days, staff posts. Zero LLM. Both the digest's due-date window and `upcoming`'s bind an explicit `now` (the caller's clock) as a query parameter rather than calling SQLite's `julianday('now')` — the real wall clock — so the same query is deterministic and testable with a fixed date (ADR-0044).
7. **Retain** — old non-course Items are archived, which is itself an event.

Every step is LLM-free. There is no step 8.

---

## 5. Plugins and sources (ADR-0017, ADR-0018, ADR-0033, ADR-0038)

Two tiers, both compiled into the one Worker:

- **Tier 1 — declarative manifest.** One HTTPS fetch (JSON or RSS) or one remote MCP tool call (`transport: mcp`, bearer or Google OAuth), plus a field mapping. Stored in D1, installable without a deploy, writable by an agent from a sample response. Supports pagination (`link-header`, cursor, page-number) and fan-out over a parent list (`src/plugins/declarative/plugin.ts`), so most REST sources fit without code.
- **Tier 2 — in-repo code.** For sources needing real logic. The campus plugin: **Ed** (token; emits thread category and staff role), **Moodle** (Okta session pushed from the user's machine and kept alive), **Canvas** (personal token; courses with term, assignments, own submissions, announcements, discussion topics; Link-header pagination).

**Gmail** is a Tier-1 MCP-transport preset against Google's official remote Gmail MCP with the user's own OAuth client (ADR-0033), scoped to university domains, mail mentioning a course code, and a sender allowlist (ADR-0036).

**Live counterpart.** Each source the Worker ingests also exists as something the client can mount directly for real-time access: the Ed and Moodle remote MCPs, `canvas-mcp` in student mode, the client's own Gmail connector. Playbooks name them as optional enrichment and must complete without them.

Not in scope: dynamic third-party sandboxed plugins; Blackboard (no personal tokens). Next candidate: Piazza.

---

## 6. Change model and buckets (ADR-0036)

**Events** are typed by what a student would ask about:

| event | carries |
|---|---|
| `item.added` / `item.archived` / `item.restored` | the item |
| `deadline.changed` | before, after |
| `state.changed` / `grade.changed` | before, after |
| `content.changed` | full before and after, never clipped |
| `notice.posted` | a staff post, optional `topic` |

Every row has `id` (cursor), `course`, `bucket`, `source`, `kind`, `url`. **Events are never pruned.** Nothing that happened is lost; the client reads it through `changes_since(cursor)` and decides what matters.

**Buckets** are the unit students actually think in:

```
course/<code>/<assignment>   deadline, submission, the Ed threads in that category, staff answers
course/<code>/general        lectures, exam arrangements, everything else about the course
life/events                  clubs, seminars, career fairs — mostly from mail
life/admin                   enrolment, fees, timetable, official notices
life/other                   the rest
```

Structured sources label themselves. Free text is labelled by the **triage playbook** running as a routine in the harness, through `label_items`. Unlabelled Items are still returned, flagged, for the client model to place on the spot. There is no regex classifier: it would miss, and a wrong bucket is worse than an honest `unlabeled`.

---

## 7. The door (ADR-0035)

`POST /mcp`. What a client agent mounts. Read-only on every source; writes only unicorn's own state.

| tool | purpose |
|---|---|
| `get_briefs` / `ack_briefs` | the durable inbox |
| `write_brief` | routines deposit their output here; idempotent |
| `changes_since(cursor)` | the lossless feed; server holds no client state |
| `course(code)` | one course across every source, grouped by bucket |
| `life()` | the non-course buckets |
| `search_items` | FTS5 over title and body |
| `upcoming(days, course?, includeOverdue?)` | deadlines in the next N days across every course, ordered by due date (ADR-0040) |
| `get_plan` / `save_plan` | shared plan state |
| `remember` | verbatim corrections |
| `run_playbook(name)` | playbook text plus its data, for tool-only clients |
| `label_items` | the triage routine's write path |
| `status()` | last sync and error per source |
| *user-defined* | up to 20 saved SQL tools (section 9) |

That is 14 fixed tools (`src/mcp/door.ts`) plus the user's own.

**Prompts.** The four playbooks — `weekly-plan`, `decompose-assignment`, `forum-brief`, `triage` — are registered under `prompts/list` so Claude Code shows them as slash commands; the same markdown comes back from `run_playbook` for ChatGPT, which consumes tools only.

**Instructions.** The server tells the client: pull briefs on session start; call `changes_since` when asked what is new; call `remember` on every correction; never answer course questions from its own knowledge.

**Error shape and the `Next:` line (ADR-0041).** Every tool's text output ends with a deterministic `Next: ...` line naming concrete follow-up calls computed from the data returned, so a client doesn't have to guess arguments. A tool failure returns `structuredContent: { error: { code, message, hint } }` plus a text block of the same shape (`Error (code): message\nNext: hint`) — never a thrown exception the client can't parse.

`POST /mcp/admin` is the operator surface (`src/mcp/server.ts`): `list_items`, `get_item`, `list_upcoming`, `list_changes`, `list_relations`, `link_items`, `list_plugin_manifests`, `put_plugin_manifest`, `get_sync_status`, `list_corrections`, plus the user-tool admin tools `describe_schema` / `define_tool` / `list_tools` / `delete_tool` / `browse_tools` / `install_tool` / `publish_tool`. A client agent never mounts it.

> `add_source` and `suggest_links` (ADR-0035/0036) were dropped by ADR-0045: sources are onboarded in `/settings` or `npm run setup`, and unplaceable items go through harness triage (`label_items`).

---

## 8. The harness side (ADR-0035)

unicorn ships nothing that reasons, so it ships the pieces that let the student's harness reason well:

- **Claude Code plugin** — the door's MCP config with the token in plugin user config, the playbooks as skills, a SessionStart hook that pulls briefs, and a `setup-routines` skill that creates the four routines through the harness's own scheduler. One `claude plugin marketplace add` and the whole loop exists.
- **Routines** — `weekly-plan` on Mondays, `decompose-assignment` daily, `forum-brief` daily, `triage` daily. Each is the harness's strong model calling door tools and, optionally, the live sources, then writing back with `write_brief`, `save_plan`, `label_items`. Claude Code routines reach unicorn as a claude.ai connector; Cowork scheduled tasks the same way.
- **claude.ai and mobile** — add unicorn as a custom connector; OAuth (section 10) makes that a click.
- **ChatGPT** — a tier-0 client: OAuth connector, `run_playbook`, widgets. ChatGPT Tasks calling connectors is undocumented and offered as best effort. Connectors need a paid ChatGPT plan; Claude's Free plan can add them.

---

## 9. User-defined tools and the library (ADR-0035)

A student's agent can grow the door without a deploy. A tool is data: name, description, input schema, one read-only SQL statement over the views `v_items`, `v_upcoming`, `v_changes`, `v_courses`, `v_buckets`. Defined on the admin surface, listed dynamically on the door, callable from every client — define `next_lab` on a laptop, call it from a phone.

Guards are mechanical, not model-judged (`src/tools/user-tools.ts`, a hand-rolled tokenizer, not a regex blacklist): `SELECT`/`WITH` only, one statement, bound named parameters, forced `LIMIT 200`, `EXPLAIN` at definition, cap of 20. Hardened past the original guard (ADR-0042):

- **Every comma-joined reference is checked**, not just the token right after `FROM`/`JOIN` — `FROM v_items, oauth_tokens` is rejected on the second table, not silently admitted.
- **A view-reference cap** (`MAX_VIEW_REFERENCES = 6`) stops a comma/cross join from multiplying `v_items`' per-row correlated subqueries into a combinatorial cost before `LIMIT 200` ever trims the output.
- **The `LIMIT 200` wrap can't be escaped** by an unmatched `)` or a trailing `--` comment: a paren-depth counter that must return to exactly zero closes off the class of attack where a stray close-paren ends the wrapper's own `(...)` early and folds the wrapper's `) LIMIT 200` into a comment.
- **`EXPLAIN` runs against the wrapped SQL at definition time**, with dummy bind values, so a tool that fails to define never becomes a tool that fails at call time.

Sharing is a GitHub repository, `unicorn-tools`, with an `index.json`: `browse_tools` reads it, `install_tool` imports one, `publish_tool` hands the agent a PR-ready payload. No hosted registry, no marketplace.

---

## 10. Auth, secrets, onboarding (ADR-0003, ADR-0013, ADR-0035, ADR-0038)

- **Door auth** — the Worker is an OAuth 2.1 authorization server (`workers-oauth-provider`, dynamic client registration on) for connectors; the consent page is behind `/settings` Basic auth, so logging in is entering `ADMIN_TOKEN`. The `MCP_TOKEN` bearer path remains for local Claude Code and development. Client ID Metadata Documents (CIMD) are enabled (`clientIdMetadataDocumentEnabled: true`), letting a client use an `https://` URL as its `client_id` with no registration round trip; this needs the `global_fetch_strictly_public` compatibility flag so unicorn's fetch of the metadata document can never land on a private address — the same flag also acts as a baseline SSRF guard for every Tier-1 manifest plugin's fetch (ADR-0043).
- **Admin auth** — bearer `ADMIN_TOKEN`, also the `/settings` password.
- **Source credentials** — Worker Secrets in the `PLUGIN_SECRET_*` namespace take precedence when set. A credential pasted into `/settings` instead is encrypted (AES-256-GCM, key derived from `ADMIN_TOKEN` via HKDF-SHA256) and stored as application state in D1 (`source_credentials`, migration `0014`, wave2/sources) — the Worker cannot mutate its own Secrets (ADR-0022), so a pasted token has nowhere else to live. Rotating `ADMIN_TOKEN` makes every stored credential undecryptable; the student re-enters it (ADR-0039). The Worker reports presence, never values. Google refresh tokens live in D1 as application state (ADR-0033). Moodle's session is pushed from the user's machine after a local Okta login.
- **Onboarding** — `npm run setup` asks which sources the student has and configures only those. `/settings` is the source form: pick a preset, enter a base URL, paste a token (straight into an encrypted D1 row or, for an existing deploy, an untouched Worker Secret), capture the browser timezone, see last sync and errors. That page is the whole web UI.

---

## 11. Widgets (ADR-0037)

Tool results carry a `ui://unicorn/<name>` resource served as `text/html;profile=mcp-app`; ChatGPT and Claude (web, desktop, mobile) render it in a sandboxed frame. One implementation for both.

| widget | tool | actions |
|---|---|---|
| brief card | `get_briefs` | ack |
| course view | `course` | — |
| changes feed | `changes_since` | — |
| plan checklist | `get_plan` | check items → `save_plan` |
| deadline timeline | `search_items` / upcoming | — |
| connection status | `status` | — |

Every result also carries its full text; the widget is additive and the text is the fallback for clients that do not render. Widget buttons call door tools and touch unicorn state only — acknowledging, planning, remembering, labelling. A widget never writes to a source.

**Model-collaboration loop (ADR-0041).** A widget is not a dead end: it can hand the model a message and tell it what just happened, gated by what the host actually supports.

- **Handoff to the model** — a button like "Discuss this" calls `ui/message` (MCP Apps) with a user-role text message, so the host treats it exactly as if the user had typed it. Under ChatGPT's pre-extension Apps SDK, which never speaks this postMessage protocol, the same button calls `window.openai.sendFollowUpMessage` instead — `src/widgets/bridge.js`'s `sendMessage()` prefers that when present and falls back to `ui/message` otherwise.
- **Advisory context after an action** — after a widget action succeeds (e.g. `save_plan` from the plan checklist), the widget calls `ui/update-model-context` with a one-line factual summary, so the model knows what happened without being asked to reply. Purely advisory: an unsupported or failed call is swallowed, never surfaced as a widget error.
- **Capability gating, not brand gating** — both calls are guarded by `hostCapabilities.message` / `hostCapabilities.updateModelContext`, returned in the `ui/initialize` handshake (`window.openai.sendFollowUpMessage` being present also counts as message support). A host that declares neither capability gets the button hidden, never a dead click.
- Every tool's text output ends with the deterministic `Next:` line (section 7) and every error carries the `{ error: { code, message, hint } }` shape — the same contract the widgets' host bridge relies on to parse a failed `callTool()`.

---

## 12. Storage, retention, what is deliberately absent

D1 holds Items, facets, events, relations, buckets, plans, briefs, corrections, plugin manifests, tool definitions, OAuth clients and grants. FTS5 indexes title and body. Secrets are Worker Secrets. Retention archives old non-course Items (and says so with an event); events themselves are kept forever — a single student will not press the free tier for years.

Absent by decision, not omission:

- no model in the Worker, no BYOK, no token ledger (ADR-0034);
- no push channels — no Telegram, Discord or email out; the client pulls (ADR-0032, ADR-0034);
- no hosted multi-tenant service, no app-directory listing; self-deploy only (ADR-0001);
- no source writes from unicorn, ever — not from tools, not from widgets;
- no vector search; a semester's corpus is small and FTS5 with a strong client model is enough;
- no dashboard; `/settings` onboards and reports, the agent reads.

---

## 13. Status (as of 2026-09-27)

Everything below is shipped and covered by tests, not a plan. Section numbers point back to where each item is described above.

- **The brain is gone (ADR-0034).** No model, no BYOK, no token ledger, no outbox, no notifier anywhere in `src/`. `npm run check` (`tsc --noEmit && vitest run`) is green with zero AI-provider dependency in `package.json`.
- **The body is unchanged and running**: hourly Durable Object alarm (§4), Ed + Moodle + Canvas ingest (§5), the zero-LLM daily digest (§4, `src/digest.ts`) bound to an injected clock rather than `julianday('now')` (ADR-0044), retention.
- **Tier-1 declarative plugins** support pagination (`link-header`, cursor, page-number) and fan-out over a parent list (`src/plugins/declarative/plugin.ts`), plus the `mcp` transport for remote-MCP sources like Gmail (§5, ADR-0033).
- **The door has 14 fixed tools** (§7, `src/mcp/door.ts`) — including `upcoming`, added past ADR-0035's original list (ADR-0040) — plus the four playbooks as MCP prompts and `run_playbook`, and up to 20 user-defined SQL tools with the hardened guard (§9, ADR-0042).
- **The admin surface** (§7, `src/mcp/server.ts`) has the item/plugin/sync inspection tools, `link_items`, and the full user-tool admin set. `add_source` and `suggest_links` were dropped (ADR-0045).
- **OAuth authorization server** (§10, `src/oauth-server.ts`) is live: DCR, PKCE S256-only, the `/authorize` consent page behind `/settings` Basic auth, and CIMD (ADR-0043).
- **Six widgets** (§11, `src/widgets/`) are built and snapshot-tested, with the model-collaboration loop (`ui/message` / `sendFollowUpMessage`, `ui/update-model-context`) capability-gated per host.
- **Buckets, `course()`, `life()`, `label_items`, and the `triage` playbook** (§6) are live; structural labelling runs every cycle (`src/kernel/courses.ts`).
- **The Claude Code plugin** (§8, `claude-plugin/`) ships the door config, the four playbook skills, a `SessionStart` hook that pulls briefs, and `setup-routines`.
- **Source onboarding by preset and encrypted D1 credentials** (§10, ADR-0038, ADR-0039) — the `/settings` source form, `source_credentials` (migration `0014`) — lands with the wave2/sources branch, which merges before release; documented here as present per that branch's code.

**Before any public post** (unchanged bar): three named students install it successfully; one of them on Canvas + Ed.
