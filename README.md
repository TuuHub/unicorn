<p align="center"><a href="https://unicorn.tuuhub.com"><img src=".github/assets/hero.jpg" alt="unicorn: the memory layer for the AI agent you already use" width="100%"></a></p>

# 🦄 unicorn

**Give your AI agent a memory of your campus.**

unicorn is a Cloudflare Worker on your own free account. Every hour it reads Ed, Moodle, Canvas, Gmail and feeds, remembers what each said, joins one course across systems, and tells your agent what changed. It is a **remote MCP server** with widgets: connect it to Claude, ChatGPT or Claude Code and that agent does the reasoning. **unicorn has no model of its own.**

[![Apache-2.0 License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> 🦄 **The memory layer of unicorn.** Live tools answer what is there now; unicorn answers what changed.
>
> 📖 **[Read the docs → unicorn.tuuhub.com/docs/unicorn](https://unicorn.tuuhub.com/docs/unicorn)**

| Use it from | How |
| --- | --- |
| Claude, ChatGPT or any web AI | Add your Worker's `/mcp` as a custom connector (OAuth) |
| Claude Code, Cowork or another local agent | Add the same `/mcp` endpoint as a remote MCP server |

Step by step for each client: [docs/CONNECTORS.md](docs/CONNECTORS.md).

## Quick start

```bash
npm run setup
```

Setup deploys the Worker to your Cloudflare account and onboards your sources one at a time. [SETUP.md](SETUP.md) has the full step list, non-interactive flags for coding agents, and the manual path. Upgrading an existing deployment: [docs/UPGRADING.md](docs/UPGRADING.md).

## Quick links

- [Why memory](#why-memory)
- [What your agent gets](#what-your-agent-gets)
- [How it works](#how-it-works)
- [Docs](#docs)

## Why memory

A source mounted directly in your client is *live*; the same source ingested by unicorn is *memory*. Both at once is the design. A client with every source mounted still cannot answer "what changed since Tuesday", cannot see that one course lives in three systems, cannot share a plan between a laptop session and a phone session, and cannot show a card instead of a paragraph. Those four are the product.

## What your agent gets

### The door (`POST /mcp`): 14 tools, read-only on every source

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

Every result carries a full text rendering ending in a deterministic `Next:` line, plus `structuredContent` for widgets. `POST /mcp/admin` (bearer `ADMIN_TOKEN`) is a separate operator surface that a client agent never mounts.

### Widgets

Six `ui://unicorn/<name>` resources, rendered by ChatGPT and Claude (web, desktop, mobile) through MCP Apps, with a full text fallback elsewhere:

| widget | tool | actions |
|---|---|---|
| brief card | `get_briefs` | `ack_briefs` |
| course view | `course` | — |
| changes feed | `changes_since` | — |
| plan checklist | `get_plan` | `save_plan` |
| deadline timeline | `upcoming` / `search_items` | — |
| connection status | `status` | — |

A widget action never writes to a source, only to unicorn's own state.

### Playbooks

Four procedures, `weekly-plan`, `decompose-assignment`, `forum-brief` and `triage`, ship as MCP prompts (slash commands in Claude Code) and through `run_playbook` for tool-only clients like ChatGPT. Your harness's own scheduler runs them on a cadence; unicorn runs no model, so it runs no schedule for them.

### Changes, buckets and the daily digest

- Every change is a typed event (`deadline.changed`, `grade.changed`, `notice.posted`, …) with a monotonic cursor, and events are never pruned.
- Every item sits in a bucket: `course/<CODE>/<assignment>`, `course/<CODE>/general`, `life/events`, `life/admin` or `life/other`. Nothing is guessed; unresolved items come back `unlabeled`.
- A zero-LLM digest lands once a day after 07:00 with what changed, the next 7 days of deadlines, and staff posts, and is skipped when nothing happened.

### Your own tools

Your agent can add up to 20 tools without a redeploy: each is a name, an input schema and one read-only SQL statement over five fixed views, checked by a mechanical guard. Tools are shared through a GitHub repository, not a hosted registry. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security

- Read-only on every source: unicorn never writes to Ed, Moodle, Canvas or Gmail. Widget actions change only unicorn's own state.
- Single-user, self-deployed: your own Worker on your own Cloudflare account, no shared service.
- The Gmail OAuth refresh token is stored in plaintext in your D1 database (`oauth_tokens` table). Treat access to that database, and to your Cloudflare account, like access to your mailbox.

## How it works

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

- **Memory layer, not a brain.** unicorn ingests, labels and remembers deterministically; zero model calls anywhere in the Worker (ADR-0034).
- **Facets are the contract.** Plugins only ingest and declare facets; change detection, buckets and retention bind to facet capabilities, so a new source with a deadline facet gets deadline tracking for free (ADR-0016, ADR-0019, ADR-0020).
- **Two plugin tiers.** Declarative JSON, RSS or remote-MCP manifests for most sources, installable without a deploy; in-repo TypeScript for Ed, Moodle and Canvas (ADR-0017, ADR-0038).
- **Single-user self-deploy.** Your Worker, your Cloudflare account, your credentials (ADR-0001).

## Docs

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

[docs/ADR.md](docs/ADR.md) is the source of truth when this file and the code disagree. The current design is ADR-0034 to ADR-0038 plus the 2026-09-27 amendments (ADR-0039 onwards); earlier ADRs record the resident-agent design that was built, measured and removed.

## 🦄 Part of unicorn

unicorn is one project in two layers. The live tools answer what is there now; unicorn answers what changed.

| Project | Layer | What it does |
| --- | --- | --- |
| **[🦄 unicorn](https://github.com/TuuHub/unicorn)** (you are here) | **Memory** | **A Cloudflare Worker on your own account. Reads Moodle, Ed, Canvas, Gmail and feeds every hour, remembers what each said, and tells your AI agent what changed. Remote MCP.** |
| [moodle-cli](https://github.com/bunizao/moodle-cli) | Live | Moodle: units, deadlines, grades, forums, files, submissions. CLI, local and remote MCP. |
| [edstem-cli](https://github.com/bunizao/edstem-cli) | Live | Ed Discussion: units, threads, lessons, files, posting. CLI, local and remote MCP. |
| [ontrack](https://github.com/bunizao/ontrack-cli) | Live | OnTrack / Doubtfire: units, tasks, chats, submissions. CLI only. |

The three CLIs share one command contract through [@bunizao/cli-kit](https://github.com/bunizao/cli-kit).

📖 **Docs:** [this project](https://unicorn.tuuhub.com/docs/unicorn) · [all projects](https://unicorn.tuuhub.com/docs) · [CLIs overview](https://unicorn.tuuhub.com/cli) · [MCP clients](https://unicorn.tuuhub.com/docs/mcp)

### Built on

unicorn stands on the live layer. Its Moodle and Ed readers grew out of the API work in moodle-cli and edstem-cli: ADR-0002 reimplemented the subset of calls it needed in TypeScript, so no code is shared and unicorn does not import the CLIs.

- [moodle-cli](https://github.com/bunizao/moodle-cli): live Moodle access; its use of Moodle's front-end JSON API (`/lib/ajax/service.php`) is what the Moodle reader follows.
- [edstem-cli](https://github.com/bunizao/edstem-cli): live Ed Discussion access; the Ed reader follows the same Ed REST API.
- [ontrack](https://github.com/bunizao/ontrack-cli): live OnTrack / Doubtfire access, used from the terminal next to unicorn. unicorn has no OnTrack source today.
- [@bunizao/cli-kit](https://github.com/bunizao/cli-kit): the command contract shared by the three CLIs.

## License

Apache License 2.0. See [LICENSE](LICENSE).
