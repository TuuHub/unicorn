# unicorn

> The memory layer of a student's own AI agent. unicorn ingests a student's campus
> sources — Ed, Moodle, Canvas, Gmail — into one Cloudflare Worker on their own free
> account, remembers what they looked like, joins one course across systems, and hands
> the result to whatever agent the student already runs through an MCP door with
> widgets. **It has no model of its own** (ADR-0034). Bring your own harness — Claude
> Code, claude.ai, ChatGPT, Cowork — and it does the reasoning; unicorn remembers,
> connects, notices change, and draws.

The rule that answers "why not just mount the source in Claude": a source mounted in
the client is *live*; the same source ingested by unicorn is *memory*. Both at once is
the design. A client with every source mounted still cannot answer "what changed since
Tuesday", cannot see that one course lives in three systems, cannot share a plan
between a laptop session and a phone session, and cannot show a card instead of a
paragraph. Those four are the product.

Production deployment: [unicorn.bunizao.workers.dev](https://unicorn.bunizao.workers.dev/health)

## Architecture, at a glance

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

Reasoning lives in the harness (interactively or on a schedule). unicorn is
deterministic end to end: ingest, diff, label, digest, retain — zero model calls
anywhere in the Worker.

## Features

### The door (`POST /mcp`) — 14 tools, read-only on every source

| tool | purpose |
|---|---|
| `get_briefs` / `ack_briefs` | the durable inbox |
| `write_brief` | routines deposit their output here; idempotent on `idempotencyKey` |
| `changes_since` | the lossless feed since a cursor — `{ events[], nextCursor, counts }` |
| `course` | one course across every source, grouped by bucket |
| `life` | the non-course buckets (`life/events`, `life/admin`, `life/other`) |
| `search_items` | FTS5 over title and body, ranked |
| `upcoming` | items with a deadline in the next N days, across every course |
| `get_plan` / `save_plan` | shared per-subject plan state |
| `remember` | verbatim corrections, zero-LLM |
| `label_items` | the triage routine's write path into buckets |
| `run_playbook` | a playbook's procedure text plus its pre-fetched data, for tool-only clients |
| `status` | last sync and error per source, no secrets |

Plus up to 20 **user-defined tools** (below). Every result carries a full text
rendering ending in a deterministic `Next:` line, and `structuredContent` for widgets.

`POST /mcp/admin` (bearer `ADMIN_TOKEN`) is the separate operator surface: item/plugin
inspection, `link_items`, and the user-tool admin tools below. A client agent never
mounts it.

### Widgets

Six `ui://unicorn/<name>` resources, rendered by ChatGPT and Claude (web, desktop,
mobile) via the MCP Apps extension, with a full text fallback for hosts that don't
render them:

| widget | tool | actions |
|---|---|---|
| brief card | `get_briefs` | `ack_briefs` |
| course view | `course` | — |
| changes feed | `changes_since` | — |
| plan checklist | `get_plan` | `save_plan` |
| deadline timeline | `upcoming` / `search_items` | — |
| connection status | `status` | — |

A widget action never writes to a source — only unicorn's own state (acknowledging,
planning, remembering, labelling).

### Playbooks

Four procedures — `weekly-plan`, `decompose-assignment`, `forum-brief`, `triage` —
shipped as markdown in `playbooks/*.md`, registered as MCP prompts (`prompts/list`, so
Claude Code shows them as slash commands) and returned by `run_playbook` for tool-only
clients like ChatGPT. Door tools are required; live source MCPs are optional
enrichment, and every procedure completes without them. The harness's own scheduler —
Claude Code routines, Cowork scheduled tasks — runs them on a cadence; unicorn runs no
model, so it runs no schedule for them either.

### The tool library and user-defined tools

A student's own agent can grow the door without a redeploy: `define_tool` on the admin
surface stores a name, description, input schema and one read-only SQL statement over
five fixed views (`v_items`, `v_upcoming`, `v_changes`, `v_courses`, `v_buckets`) — a
tool is data, never code. Guards are mechanical (a hand-rolled SQL tokenizer, not a
model judgment): `SELECT`/`WITH` only, one statement, bound named parameters, every
FROM/JOIN target checked against the five views or the statement's own CTEs, a forced
`LIMIT 200` wrap that can't be escaped by paren or comment tricks, a cap of 20 tools,
and an `EXPLAIN` against the real schema at definition time. `describe_schema` reads
back each view's columns and an example row. Sharing is a GitHub repository
(`unicorn-tools`, `index.json`): `browse_tools`, `install_tool`, `publish_tool` (which
hands the caller's agent a PR-ready payload — the Worker never pushes to GitHub
itself). No hosted registry.

### changes_since and buckets

Every change is a typed event (`item.added`, `item.archived`, `item.restored`,
`deadline.changed`, `state.changed`, `grade.changed`, `content.changed`,
`notice.posted`) with a monotonic cursor. Events are never pruned. Every item also
carries a bucket — `course/<CODE>/<assignment>`, `course/<CODE>/general`,
`life/events`, `life/admin`, `life/other` — labelled deterministically at ingest for
structured sources, or by the `triage` playbook for free text. Nothing is guessed:
unresolved items come back flagged `unlabeled` for the client to place.

### The daily digest

A zero-LLM brief, written once a day at or after 07:00 in the configured timezone,
listing what changed since the last digest, deadlines in the next 7 days, and staff
posts — skipped entirely when nothing happened. Read it through `get_briefs` like any
other brief.

## Quickstart

```bash
npm run setup
```

See [SETUP.md](SETUP.md) for the full step list (source-by-source onboarding,
non-interactive flags for coding agents, and the manual path), and
[docs/CONNECTORS.md](docs/CONNECTORS.md) for adding unicorn to Claude Code, claude.ai,
Claude mobile/Cowork, or ChatGPT once it's deployed. Upgrading an existing deployment
instead of a first install: [docs/UPGRADING.md](docs/UPGRADING.md).

## Docs index

| doc | what's in it |
|---|---|
| [SETUP.md](SETUP.md) | Deploy and onboard sources, human or coding-agent path |
| [docs/UPGRADING.md](docs/UPGRADING.md) | Upgrading a production deploy from the pre-memory-layer agent |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The end-state system, section by section, and what's shipped |
| [docs/ADR.md](docs/ADR.md) | The decision trail — read this when this doc and the code disagree |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Vocabulary: bucket, cursor, brief, plan, playbook, widget, door, CIMD, … |
| [docs/CONNECTORS.md](docs/CONNECTORS.md) | Adding unicorn as a connector to each client |
| [docs/MANIFESTS.md](docs/MANIFESTS.md) | Writing a Tier-1 declarative plugin manifest |
| [docs/GMAIL.md](docs/GMAIL.md) | The Gmail source: OAuth, scope, the preset manifest |
| [docs/PI-AGENT-PRODUCT.md](docs/PI-AGENT-PRODUCT.md) | *Historical* — the in-Worker agent ADR-0034 removed |
| [docs/SPIKE-0001-MOODLE-AUTH.md](docs/SPIKE-0001-MOODLE-AUTH.md) | The original Moodle feasibility spike |

## Design principles

- **Memory layer, not a brain.** unicorn ingests, labels, and remembers deterministically;
  the harness's own model does all the reasoning (ADR-0034). The whole Worker is
  LLM-free — no BYOK, no token ledger, no degradation chain to reason about.
- **Live vs. memory, not live vs. mounted.** Mounting a source directly in the client
  gives real-time reach; ingesting it into unicorn gives a baseline, change detection,
  and a cross-source join. Both together is the design, not a redundancy.
- **Facets are the contract.** Plugins only ingest and declare which facets they emit.
  Change detection, buckets, and retention bind to facet *capabilities* — five
  primitives (`temporal`, `state`, `relation`, `actor`, `scalar`) — not to plugins, so a
  new source that emits a `has-deadline` facet inherits deadline tracking for free.
  (ADR-0016, ADR-0019, ADR-0020)
  Details:
  - **Two plugin tiers.** Declarative JSON/RSS/remote-MCP manifests for most sources
    (installable without a deploy); in-repo TypeScript for the few needing real logic
    — Ed, Moodle, and Canvas (ADR-0017, ADR-0038).
- **Single-user self-deploy.** Your own Worker on your own free Cloudflare account. No
  multi-tenant service, no shared quota, credentials stay yours (ADR-0001).
- **The harness is the investment.** Playbooks, tool projections, widgets, and the
  Claude Code plugin are what get new effort; new sources are plugins, not new
  reasoning code (ADR-0029, ADR-0034).

## Architecture Decision Records

Read [docs/ADR.md](docs/ADR.md) in order — it's the source of truth when this file and
the code disagree. The current end-state is ADR-0034 through ADR-0038 plus the
2026-09-27 amendments (ADR-0039–0044); everything before ADR-0034 documents the
resident-agent design that was built, measured, and then removed.

| ADR | Decision |
|-----|----------|
| 0001–0033 | Superseded design history — self-deploy, the plugin/facet model, the resident Pi agent, the four-tool door, playbooks and briefs, Gmail ingest. Kept for the trail. |
| **0034** | **Brain removed: unicorn is the memory layer; reasoning runs in the harness** |
| **0035** | **Door v2: state tools, MCP prompts, OAuth for connectors, user-defined SQL tools** |
| **0036** | **Change model and buckets: lossless events, five buckets, harness-side triage** |
| **0037** | **Widgets: MCP Apps resources, six widgets, text fallback** |
| **0038** | **Canvas: Tier-2 ingest plugin; canvas-mcp is the live toolbelt; onboarding by source** |
| 0039+ | 2026-09-27 amendments — source-credential encryption, `upcoming`, the widget model-collaboration loop, the SQL guard hardening, OAuth CIMD, the injected clock. See [docs/ADR.md](docs/ADR.md). |

## Related projects

- [edstem-cli](https://github.com/bunizao/edstem-cli) — terminal-first Ed Discussion client
- [moodle-cli](https://github.com/bunizao/moodle-cli) — terminal-first Moodle client

## License

Apache License 2.0. See [LICENSE](LICENSE).
