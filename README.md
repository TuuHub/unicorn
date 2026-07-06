# unicorn

> An AI-native information aggregation platform. Plugins bring the sources; unicorn ingests everything into one model, tracks what matters, and lets your own AI agent query it — all on a single Cloudflare Worker, on your own free account. Campus (Ed Discussion + Moodle) is the flagship plugin.

**Status:** design phase. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the end-state picture, [docs/ADR.md](docs/ADR.md) for the decision trail, and [docs/GLOSSARY.md](docs/GLOSSARY.md) for the vocabulary. No runtime code yet.

## What it is

unicorn is a **plugin platform first**. Plugins ingest from any source; the kernel normalizes everything into a **generic Item + optional typed facets** model, detects changes, and drives all downstream behavior (tracking, jobs, notifications) generically off those facets. The **campus plugin** (Ed + Moodle) is the flagship that dogfoods the kernel — it's how v1 keeps a real pain point (tracking assessments across platforms) pulling on the design.

Three surfaces, all thin faces over one kernel:

- **MCP server** *(v1)* — connect from your own Claude / ChatGPT client; your agent does the reasoning, unicorn serves the data.
- **Web dashboard** *(later)* — read-only timeline + settings.
- **IM bot** *(later)* — proactive push (daily digest, imminent deadlines) via Telegram / Discord / email.

Optional server-side agent jobs (daily digest, triage, planning) run on your Claude/Codex subscription quota or a BYOK key, with hard budget caps and a degradation chain so ingestion never dies when an LLM does.

## Design principles

- **Plugin platform, campus as proof.** The kernel is designed for arbitrary sources; Ed/Moodle is the flagship plugin, not the product's ceiling.
- **Hybrid data model.** Generic Item base means 海纳百川; optional capability-typed facets mean the platform can actually *do* things (deadline tracking, unread, threads). The LLM supplies missing structure at read time — that's what "AI-native" means here.
- **Facets are the contract.** Plugins only ingest + declare which facets they emit. Change detection, jobs, notifications, and retention bind to facet *capabilities*, not to plugins — so a new source that emits a `has-deadline` facet inherits ddl tracking for free.
- **Two plugin tiers.** Declarative manifests (AI generates the field mapping from a sample response) for the many API/RSS sources; in-repo code plugins for the few needing real logic (campus).
- **Single-user self-deploy.** Your own Worker on your own free Cloudflare account. No multi-tenant service, no shared quota, credentials stay yours.
- **LLM-optional pipeline.** Ingestion runs with zero LLM. Reasoning happens in your own MCP client, or in opt-in server jobs you budget.

## Architecture

Read the decision records in order — they're the source of truth:

| ADR | Decision |
|-----|----------|
| 0001 | Single-user self-deploy template |
| 0002 | Pure TypeScript Worker; reimplement the needed subset (Moodle is clean AJAX JSON) |
| 0003 | Moodle auth: layered keep-alive + optional full-auto |
| 0004 | Server-side LLM with degradation chain |
| 0005 | Course / Assessment / Event data model *(generalized by 0016 → now campus-plugin facets)* |
| 0006 | v1 scope: MCP + cron + D1 |
| 0007 | LLM layer: Vercel AI SDK + custom subscription providers |
| 0008 | Agent job registry with metering + hard budget caps |
| 0009 | Surfaces: shared kernel, three faces |
| 0010 | Pluggable notifier abstraction |
| 0011 | Data retention: hot current term, cold archive |
| 0012 | Source-adapter abstraction *(subsumed by 0017/0018)* |
| 0013 | Secrets: CF Secrets baseline, sensitive items quarantined |
| 0014 | Single flat repo, no workspaces |
| **0015** | **Reframe: AI-native aggregation platform; campus is the flagship plugin** |
| **0016** | **Universal data model: hybrid generic Item + optional typed facets** |
| **0017** | **Plugin runtime: two tiers (declarative manifests + code plugins)** |
| **0018** | **Plugin contract: ingestion + facet declaration only; downstream is facet-driven** |
| **0019** | **Facet vocabulary: open facets, behavior bound to declared capabilities** |

## Related projects

- [edstem-cli](https://github.com/bunizao/edstem-cli) — terminal-first Ed Discussion client
- [moodle-cli](https://github.com/bunizao/moodle-cli) — terminal-first Moodle client

## License

Apache License 2.0. See [LICENSE](LICENSE).
