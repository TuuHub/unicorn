# unicorn — Architecture (end-state)

This describes the whole system in its intended final form, from zero. It's the synthesized picture; the decision trail and rationale live in [ADR.md](ADR.md), the vocabulary in [GLOSSARY.md](GLOSSARY.md). When this doc and an ADR disagree, the ADR is authoritative (it records *why*); fix this doc.

Rewritten 2026-09-21 for ADR-0034 – ADR-0038. Section 13 records what is built and what is next as of that date.

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
2. exact match on the normalised code, with `term` when both sides carry one, else the current active offering;
3. nothing automatic beyond that — `suggest_links` lists fuzzy candidates for the agent to confirm.

Assessment ↔ Ed category uses the same ladder on normalised titles. Ambiguity is returned, never resolved by guessing.

---

## 4. The ingestion lifecycle

One scheduler cycle, hourly, a self-renewing Durable Object alarm (ADR-0021):

1. **Fetch** — each enabled plugin pulls its source with its own auth.
2. **Normalize** — plugin maps payload → Items + facets. Tier-1 runs a manifest; Tier-2 runs code.
3. **Diff** — kernel compares against the stored Item.
4. **Events** — differences become typed events (section 6), each with a monotonic id that doubles as the client cursor.
5. **Label** — structured Items get their bucket deterministically: an assessment owns its bucket; an Ed thread joins the assessment bucket its category matches, else `general`. Free text stays unlabelled until the triage routine runs.
6. **Digest** — once a day at the user's local 07:00, if anything happened: a brief listing changes since the last digest, deadlines in 7 days, staff posts. Zero LLM.
7. **Retain** — old non-course Items are archived, which is itself an event.

Every step is LLM-free. There is no step 8.

---

## 5. Plugins and sources (ADR-0017, ADR-0018, ADR-0033, ADR-0038)

Two tiers, both compiled into the one Worker:

- **Tier 1 — declarative manifest.** One HTTPS fetch (JSON or RSS) or one remote MCP tool call (`transport: mcp`, bearer or Google OAuth), plus a field mapping. Stored in D1, installable without a deploy, writable by an agent from a sample response. Planned extension: pagination and fan-out over a list, so most REST sources fit without code.
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
| `get_plan` / `save_plan` | shared plan state |
| `remember` | verbatim corrections |
| `run_playbook(name)` | playbook text plus its data, for tool-only clients |
| `label_items` | the triage routine's write path |
| `status()` | last sync and error per source |
| *user-defined* | up to 20 saved SQL tools (section 9) |

**Prompts.** The four playbooks — `weekly-plan`, `decompose-assignment`, `forum-brief`, `triage` — are registered under `prompts/list` so Claude Code shows them as slash commands; the same markdown comes back from `run_playbook` for ChatGPT, which consumes tools only.

**Instructions.** The server tells the client: pull briefs on session start; call `changes_since` when asked what is new; call `remember` on every correction; never answer course questions from its own knowledge.

`POST /mcp/admin` is the operator surface: `add_source`, `link_items`, `suggest_links`, `define_tool` / `list_tools` / `delete_tool` / `describe_schema`, `browse_tools` / `install_tool` / `publish_tool`, plus inspection. A client agent never mounts it.

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

Guards are mechanical, not model-judged: `SELECT`/`WITH` only, one statement, bound parameters, view-only access, forced `LIMIT 200`, `EXPLAIN` at definition, cap of 20.

Sharing is a GitHub repository, `unicorn-tools`, with an `index.json`: `browse_tools` reads it, `install_tool` imports one, `publish_tool` hands the agent a PR-ready payload. No hosted registry, no marketplace.

---

## 10. Auth, secrets, onboarding (ADR-0003, ADR-0013, ADR-0035, ADR-0038)

- **Door auth** — the Worker is an OAuth 2.1 authorization server (`workers-oauth-provider`, dynamic client registration on) for connectors; the consent page is behind `/settings` Basic auth, so logging in is entering `ADMIN_TOKEN`. The `MCP_TOKEN` bearer path remains for local Claude Code and development.
- **Admin auth** — bearer `ADMIN_TOKEN`, also the `/settings` password.
- **Source credentials** — Worker Secrets in the `PLUGIN_SECRET_*` namespace; the Worker reports presence, never values, and cannot mutate its own secrets (ADR-0022). Google refresh tokens live in D1 as application state (ADR-0033). Moodle's session is pushed from the user's machine after a local Okta login.
- **Onboarding** — `npm run setup` asks which sources the student has and configures only those. `/settings` is the source form: pick a preset, enter a base URL, paste a token (straight into a secret, never through a model), capture the browser timezone, see last sync and errors. That page is the whole web UI.

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

## 13. Build order (as of 2026-09-21)

Shipped and in production through ADR-0033: the body, Ed + Moodle + Gmail ingest, events v1, briefs and plans, the four-tool door, the admin surface, the resident Pi agent and its playbook runner. ADR-0034 removes the last item.

**This week** — everything a client with direct sources cannot do, in dependency order:

1. Remove the brain, outbox and notifier; add the zero-LLM daily digest.
2. OAuth authorization server on the Worker; keep bearer.
3. Claude Code plugin with skills, SessionStart hook, `setup-routines`.
4. Playbooks as MCP prompts plus `run_playbook`; `write_brief`.
5. Events v2 and `changes_since`.
6. FTS5 behind `search_items`.
7. The brief-card widget.

**Next** — buckets, `course()` and `life()`, the triage routine and `label_items`, `define_tool` and the tool library, the Canvas plugin and the `/settings` source form, the remaining widgets, Tier-1 pagination and fan-out.

**Before any public post** — three named students install it successfully; one of them on Canvas + Ed.
