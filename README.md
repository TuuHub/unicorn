# unicorn

> One creature that watches your whole campus. A self-deployed toolkit that aggregates your courses across platforms, tracks every assessment, and lets your own AI agent query it — all on a single Cloudflare Worker, on your own free account.

**Status:** design phase. See [docs/ADR.md](docs/ADR.md) for the architecture decisions and [docs/GLOSSARY.md](docs/GLOSSARY.md) for the vocabulary. No runtime code yet.

## What it is

unicorn pulls from your campus platforms (Ed Discussion and Moodle first), normalizes everything into a unified Course / Assessment / Event model, detects changes (new posts, shifted deadlines, status updates), and exposes it three ways:

- **MCP server** *(v1)* — connect from your own Claude / ChatGPT client; your agent does the reasoning, unicorn serves the data.
- **Web dashboard** *(later)* — read-only assessment timeline + settings.
- **IM bot** *(later)* — proactive push (daily digest, imminent deadlines) via Telegram / Discord / email.

Optional server-side agent jobs (daily digest, post triage, deadline planning) run on your Claude/Codex subscription quota or a BYOK key, with hard budget caps and a degradation chain so ingestion never dies when an LLM does.

## Design principles

- **Single-user self-deploy.** You deploy your own Worker to your own free Cloudflare account. No multi-tenant service, no shared quota, your credentials stay yours.
- **One Worker, three faces.** cron engine + D1 + job registry is the single source of truth; every surface is a thin face over it.
- **Source adapters.** Ed and Moodle first; new platforms are one adapter each.
- **LLM-optional.** The data pipeline runs with zero LLM. Reasoning happens in your own MCP client, or in opt-in server jobs you budget.

## Architecture

Read the decision records in order — they're the source of truth:

| ADR | Decision |
|-----|----------|
| 0001 | Single-user self-deploy template |
| 0002 | Pure TypeScript Worker; reimplement the needed subset (Moodle is clean AJAX JSON) |
| 0003 | Moodle auth: layered keep-alive + optional full-auto |
| 0004 | Server-side LLM with degradation chain |
| 0005 | Unified Course / Assessment / Event data model |
| 0006 | v1 scope: MCP + cron + D1 |
| 0007 | LLM layer: Vercel AI SDK + custom subscription providers |
| 0008 | Agent job registry with metering + hard budget caps |
| 0009 | Surfaces: shared kernel, three faces |
| 0010 | Pluggable notifier abstraction |
| 0011 | Data retention: hot current term, cold archive |
| 0012 | Source-adapter abstraction |
| 0013 | Secrets: CF Secrets baseline, sensitive items quarantined |

## Related projects

- [edstem-cli](https://github.com/bunizao/edstem-cli) — terminal-first Ed Discussion client
- [moodle-cli](https://github.com/bunizao/moodle-cli) — terminal-first Moodle client

## License

Apache License 2.0. See [LICENSE](LICENSE).
