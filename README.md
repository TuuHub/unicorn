# unicorn

> An AI-native information aggregation platform. Plugins bring the sources; unicorn ingests everything into one model, tracks what matters, and lets your own AI agent query it — all on a single Cloudflare Worker, on your own free account. Campus (Ed Discussion + Moodle) is the flagship plugin.

**Status:** v1 alpha is deployed. The original Moodle feasibility work is recorded in [the authentication spike](docs/SPIKE-0001-MOODLE-AUTH.md). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the end-state picture, [docs/ADR.md](docs/ADR.md) for the decision trail, and [docs/GLOSSARY.md](docs/GLOSSARY.md) for the vocabulary.

## Current v1

The Worker runtime now includes:

- D1-backed Item, facet, capability, Event, relation, settings, and manifest storage
- Moodle and Ed Discussion Campus plugins
- Tier-1 declarative JSON and RSS/Atom plugins
- authenticated Streamable HTTP MCP tools, including capped agent-memory notes
- protected settings, retention, and Discord / Telegram / email notifications through a durable outbox
- a Pi-backed resident agent over authenticated HTTP and Telegram, with D1 conversation history and per-conversation Durable Object serialization
- an hourly Durable Object scheduler, a resident triage job, and opt-in BYOK model jobs with measured token caps

Production deployment: [unicorn.bunizao.workers.dev](https://unicorn.bunizao.workers.dev/health)

## Deploy

One command handles the whole path (ADR-0027) — see [SETUP.md](SETUP.md) for the step list and the coding-agent notes:

```bash
npm run setup
```

It runs `wrangler login`, creates D1 and writes the `database_id` back into `wrangler.jsonc`, applies migrations, generates random `ADMIN_TOKEN`/`MCP_TOKEN` secrets, optionally pushes Ed and Moodle credentials, deploys, and starts the scheduler.

<details>
<summary>Manual path</summary>

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

</details>

Generate separate random values for `ADMIN_TOKEN` and `MCP_TOKEN`. `ADMIN_TOKEN` is the password for HTTP Basic user `unicorn` at `/settings` and the bearer token for `/sync` and `/agent`; `MCP_TOKEN` protects `/mcp`. Reusing them needlessly turns one leaked client credential into full operator access.

MCP clients connect to `https://<your-worker>/mcp` with `Authorization: Bearer <MCP_TOKEN>`.

The `resident-agent`, `daily-digest`, and `triage` jobs are disabled by default. To use them, set `AI_API_KEY`, choose an OpenAI-compatible `AI_BASE_URL`, then enable each through the `configure_agent_job` MCP tool with its model and monthly token cap. Actual input/output usage and measured monthly projections are exposed through MCP. Reaching a cap rejects new resident turns or pauses the scheduled model path without ever stopping ingestion.

The resident HTTP surface uses the operator token:

```bash
curl https://<your-worker>/agent \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"operator","message":"What matters today?","idempotencyKey":"request-1"}'
```

`DELETE /agent?conversationId=operator` clears only that conversation. Pi can call compact read-only tools for items, deadlines, changes, memory, and sync status; it has no arbitrary fetch, SQL, shell, secret, or source-write capability.

## What it is

unicorn is a **plugin platform first**. Plugins ingest from any source; the kernel normalizes everything into a **generic Item + optional typed facets** model, detects changes, and drives all downstream behavior (tracking, jobs, notifications) generically off those facets. The **campus plugin** (Ed + Moodle) is the flagship that dogfoods the kernel — it's how v1 keeps a real pain point (tracking assessments across platforms) pulling on the design.

On top of the kernel, unicorn is becoming a **resident secretary agent** (ADR-0023): an event-driven triage loop that watches every facet event, suppresses noise, speaks only when something matters, and remembers your corrections in a capped notes memory (ADR-0024). Two faces over one kernel (ADR-0026):

- **MCP server** *(v1)* — the pull face: your own Claude / ChatGPT client consults unicorn's structured data and memory; your agent does the open-ended reasoning.
- **IM** *(v1)* — proactive alerts and digests plus a persistent Pi conversation in Telegram.

There is deliberately no maintained web dashboard and no daily-driver CLI — views are rendered reports (`/settings`, `/digest`) or generated on demand by your MCP client.

Server-side agent jobs (triage, daily digest, planning) run on your Claude/Codex subscription quota or a BYOK key, with hard budget caps and a degradation chain so ingestion never dies when an LLM does. The **resident triage job** (ADR-0023) is the v1 secretary: deterministic reflexes decide the clear cases with zero LLM, a cheap model judges only the ambiguous middle, and it remembers your corrections in a capped notes memory (ADR-0024) your MCP client can edit.

## Design principles

- **Plugin platform, campus as proof.** The kernel is designed for arbitrary sources; Ed/Moodle is the flagship plugin, not the product's ceiling.
- **Thick body, thin brain.** The kernel (deterministic perception, facets, scheduling) is the moat; the resident triage loop stays thin and commodity. Every feature passes the weekend test: if a generic agent framework could copy it in a weekend, keep it thin.
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
| 0007 | Original LLM layer choice *(superseded by 0028)* |
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
| **0023** | **Reframe: unicorn is a resident agent; thick body, thin brain** |
| **0024** | **Agent memory: facts in D1, judgment in capped notes; no vectors** |
| **0025** | **Event-driven serverless is load-bearing; capability ladder for heavy work** |
| **0026** | **Surfaces: IM push/converse + MCP pull; UI is output, not asset** |
| **0027** | **Onboarding: one in-repo setup script shared by humans and agents** |
| **0028** | **Pi resident brain behind a narrow runtime seam** |

## Related projects

- [edstem-cli](https://github.com/bunizao/edstem-cli) — terminal-first Ed Discussion client
- [moodle-cli](https://github.com/bunizao/moodle-cli) — terminal-first Moodle client

## License

Apache License 2.0. See [LICENSE](LICENSE).
