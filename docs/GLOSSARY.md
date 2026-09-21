# Glossary — unicorn

Terms as we use them in this project. When code and this file disagree, fix one of them. Terms marked *Retired* describe code that ADR-0034 removes; they stay here so older ADRs still read.

## Product

- **unicorn** — The memory layer of a student's own AI agent: one Cloudflare Worker on their free account that ingests campus sources hourly, remembers them, joins one course across systems, and serves the result to the student's client (Claude Code, claude.ai, ChatGPT, Cowork) through an MCP door with widgets. It has no model of its own. (ADR-0034)
- **Live vs memory** — The same source in two places by design: mounted in the client it is *live* (real-time, stateless); ingested by unicorn it is *memory* (baseline, change detection, cross-source join). The rule that answers "why not just mount it in Claude". (ADR-0034)
- **Harness** — The student's client plus its scheduler plus the plugin we ship for it. Where reasoning runs. Not our code, except the plugin. (ADR-0035)
- **Worker** — The single Cloudflare Worker (TypeScript) that is the whole deployable: scheduled ingestion, D1, the door and admin MCP servers, the OAuth server, the scheduler Durable Object, and `/settings`.

## Body

- **Kernel** — The source-agnostic core: ingestion, D1 storage, Item + facet model, change detection, buckets, the course resolver, the daily digest, retention. Everything a plugin can't touch. (ADR-0015, ADR-0036)
- **Plugin** — A source integration: identity, auth, fetch, mapping, emitted facets. Ingestion only. Tier 1 = declarative manifest (one HTTPS fetch or one remote MCP tool call); Tier 2 = in-repo code. (ADR-0017, ADR-0018, ADR-0033)
- **Campus plugin** — The Tier-2 bundle of Ed Discussion, Moodle and Canvas. Reimplements the small API subset it needs; does not import the sibling CLIs. (ADR-0002, ADR-0038)
- **canvas-mcp** — `vishalsachdev/canvas-mcp`, the recommended *live* Canvas source for the client (student profile). unicorn ingests Canvas with its own plugin and does not call canvas-mcp. (ADR-0038)
- **Item** — The generic record every plugin produces: `id, source, kind, title, timestamp, url, body, raw`, plus `bucket`, `topic`, `labeled_by`. (ADR-0016, ADR-0036)
- **Facet** — An optional typed structure on an Item (`course-identity`, `deadline`, `thread`, `author`, …). Open vocabulary. (ADR-0016)
- **Capability / primitive** — A capability binds one facet field to one of five behavior primitives: `temporal`, `state`, `relation`, `actor`, `scalar`. New capabilities need no kernel change. (ADR-0019, ADR-0020)
- **course-identity** — The facet that names a course: `code`, `term`, `title`. `term` distinguishes offerings of the same code. (ADR-0036)
- **Course resolver** — The ladder that answers "which Items are this course": confirmed relation → normalised code (+ term) → nothing automatic; fuzzy candidates only via `suggest_links`. Ambiguity is returned, never guessed. (ADR-0036)
- **Relation** — A confirmed link between two Items across sources (`same-course`), written by `link_items`. The first rung of the resolver. (ADR-0005, ADR-0036)
- **Ingestion / cycle** — The hourly scheduler-driven pull: fetch, normalize, diff, events, structural labels, daily digest, retention. LLM-free end to end. (ADR-0021, ADR-0034)
- **keep-alive** — A cycle step that loads Moodle `/my/` to keep the Okta session warm and derive a fresh `sesskey`. (ADR-0003)
- **Event** — A row recording one change in student terms: `item.added / archived / restored`, `deadline.changed`, `state.changed`, `grade.changed`, `content.changed`, `notice.posted`. Monotonic id = the client cursor. Never pruned. (ADR-0036)
- **Cursor** — The event id a client passes to `changes_since` to get everything after it. Held by the client; the server keeps no per-client state. (ADR-0035)
- **Bucket** — A two-level path on an Item: `course/<code>/<assignment>`, `course/<code>/general`, `life/events`, `life/admin`, `life/other`. The unit students think in. (ADR-0036)
- **Label / triage** — Assigning a bucket (and optional `topic`). Structured Items are labelled at ingest (`labeled_by: structure`); free text is labelled by the `triage` playbook running as a routine (`triage`), or by the client on the spot (`client`). No regex classifier. (ADR-0036)
- **Daily digest** — A zero-LLM brief written once a day at the user's local 07:00 when anything happened: changes since the last digest, deadlines in 7 days, staff posts. (ADR-0034)
- **hot / archived** — Retention states. Archiving emits `item.archived`; a re-pulled Item becomes hot again. (ADR-0011, ADR-0036)

## Door and harness

- **Door** — `POST /mcp`, the one MCP server a client agent mounts: state tools, MCP prompts, widgets, user-defined tools. Read-only on sources. (ADR-0035)
- **Admin surface** — `POST /mcp/admin`, bearer `ADMIN_TOKEN`: sources, links, tool definitions, inspection. Never mounted by a client agent. (ADR-0030, ADR-0035)
- **Brief** — A durable inbox row (`briefs` table) read through `get_briefs`, acknowledged through `ack_briefs`, written by the daily digest and by routines through `write_brief`. (ADR-0031, ADR-0035)
- **Plan** — A saved per-subject text artifact (`plans` table, one row per kind + subject) written with `save_plan`, read with `get_plan`, shared across every client. (ADR-0031)
- **Playbook** — A markdown procedure (`weekly-plan`, `decompose-assignment`, `forum-brief`, `triage`) served as an MCP prompt and through `run_playbook`, executed by the client's model. Door tools required; live sources optional. (ADR-0031, ADR-0035)
- **Routine** — A scheduled run of a playbook by the harness's own scheduler (Claude Code routines, Cowork scheduled tasks). Reaches unicorn as a connector. (ADR-0035)
- **Plugin (Claude Code)** — The package we ship for Claude Code: door MCP config, playbooks as skills, a SessionStart hook that pulls briefs, a `setup-routines` skill. Distinct from a *source* plugin. (ADR-0035)
- **Connector** — A remote MCP server added in claude.ai or ChatGPT. Requires OAuth; the Worker is the authorization server. (ADR-0035)
- **User-defined tool** — A door tool that is data, not code: name, description, input schema, one read-only SQL statement over the `v_*` views. Defined by the student's agent on the admin surface; up to 20. (ADR-0035)
- **Tool library** — The `unicorn-tools` GitHub repository with an `index.json`; `browse_tools`, `install_tool`, `publish_tool`. No hosted registry. (ADR-0035)
- **Widget** — A `ui://unicorn/<name>` HTML resource attached to a tool result, rendered by ChatGPT and Claude via the MCP Apps extension. Additive to the text result; actions touch unicorn state only. (ADR-0037)
- **Settings page** — `/settings`, Basic auth with `ADMIN_TOKEN`: onboarding by source, token entry straight into secrets, OAuth consent, timezone, sync status. The only web page; not a dashboard. (ADR-0022, ADR-0038)

## Retired

- **Resident agent / Pi loop / `ask`** — *Retired (ADR-0034).* The in-Worker agent of ADR-0028/0029. Removed; reasoning moved to the harness.
- **BYOK, Workers AI runtime, subscription token, AI SDK interface, degradation chain, job registry, hard cap** — *Retired (ADR-0034).* The server-side LLM layer of ADR-0004/0007/0008. The Worker calls no model.
- **notifier / outbox** — *Retired (ADR-0034).* Push channels of ADR-0010/0032. The client pulls.
- **Judgment notes memory** — *Retired (ADR-0034).* The capped-notes half of ADR-0024; buckets and labels replace it. The `corrections` domain behind `remember` stays.
- **Runner (local)** — *Rejected* earlier: a local process pulling LLM tasks. Never built.
- **Source adapter** — Historical name for a Tier-2 plugin. (ADR-0012)
- **edstem-cli / moodle-cli** — The sibling CLIs, now also remote MCP servers. Live sources for the client; unicorn does not import them. (ADR-0002)
