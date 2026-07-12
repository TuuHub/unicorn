# unicorn

> An AI-native information aggregation platform. Plugins bring the sources; unicorn ingests everything into one model, tracks what matters, and lets your own AI agent query it — all on a single Cloudflare Worker, on your own free account. Campus (Ed Discussion + Moodle) is the flagship plugin.

**Status:** v1 alpha is deployed. The original Moodle feasibility work is recorded in [the authentication spike](docs/SPIKE-0001-MOODLE-AUTH.md). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the end-state picture, [docs/ADR.md](docs/ADR.md) for the decision trail, and [docs/GLOSSARY.md](docs/GLOSSARY.md) for the vocabulary.

## Current v1

The Worker runtime now includes:

- D1-backed Item, facet, capability, Event, relation, settings, and manifest storage
- Moodle and Ed Discussion Campus plugins
- Tier-1 declarative JSON and RSS/Atom plugins
- authenticated Streamable HTTP MCP tools
- protected settings, retention, and optional Discord notifications
- an hourly Durable Object scheduler and an opt-in BYOK daily digest with measured token caps

Production deployment: [unicorn.bunizao.workers.dev](https://unicorn.bunizao.workers.dev/health)

## Deploy

```bash
npm install
npx wrangler login
npx wrangler d1 create unicorn
# Put the returned database_id into wrangler.jsonc, then:
npm run db:migrate
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put MCP_TOKEN
npx wrangler secret put ED_API_TOKEN       # optional
npm run moodle:push                         # optional; reads okta-auth session
npm run deploy
# Start the persistent hourly scheduler with ADMIN_TOKEN:
curl -X POST https://<your-worker>/schedule -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Generate separate random values for `ADMIN_TOKEN` and `MCP_TOKEN`. `ADMIN_TOKEN` is the password for HTTP Basic user `unicorn` at `/settings` and the bearer token for `/sync`; `MCP_TOKEN` protects `/mcp`. Reusing them needlessly turns one leaked client credential into full operator access.

MCP clients connect to `https://<your-worker>/mcp` with `Authorization: Bearer <MCP_TOKEN>`.

The `daily-digest` agent job is disabled by default. To use it, set `AI_API_KEY`, choose an OpenAI-compatible `AI_BASE_URL`, then enable it through the `configure_agent_job` MCP tool with a UTC schedule hour and monthly token cap. Actual input/output usage and measured monthly projections are exposed through MCP. The runner reserves prompt and output budget before every call; reaching the cap disables the job, sends a notifier warning when configured, and never stops ingestion.

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
| **0020** | **Five behavior primitives form the finite kernel surface** |
| **0021** | **Durable Object alarm provides account-independent scheduling** |
| **0022** | **Settings never self-mutate Worker Secrets** |

## Related projects

- [edstem-cli](https://github.com/bunizao/edstem-cli) — terminal-first Ed Discussion client
- [moodle-cli](https://github.com/bunizao/moodle-cli) — terminal-first Moodle client

## License

Apache License 2.0. See [LICENSE](LICENSE).
