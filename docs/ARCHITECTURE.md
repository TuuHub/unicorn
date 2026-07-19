# unicorn — Architecture (end-state)

This describes the whole system in its intended final form, from zero. It's the synthesized picture; the decision trail and rationale live in [ADR.md](ADR.md), the vocabulary in [GLOSSARY.md](GLOSSARY.md). When this doc and an ADR disagree, the ADR is authoritative (it records *why*); fix this doc.

---

## 1. What unicorn is, in one paragraph

unicorn is an **AI-native information aggregation platform** you deploy to your own free Cloudflare account as a **single Worker**. Plugins ingest from arbitrary sources (campus platforms, RSS, APIs, …) into one generic model; the kernel detects changes, tracks what matters, and exposes everything to **your own** AI agent over MCP — plus optional server-side jobs that summarize and notify on your LLM quota. The **campus plugin** (Ed Discussion + Moodle) is the flagship that proves the kernel against a real pain: tracking assessments scattered across platforms.

The design bet (ADR-0015/0016): a generic data model would normally cripple a platform, because tracking and reasoning need structure. unicorn resolves that by being **AI-native** — structured behavior binds where plugins declare it, and an LLM supplies structure everywhere else at read time. So the platform sits far toward "accepts anything" without becoming a dumb blob store.

---

## 2. The shape: one Worker, one kernel, three faces

Everything is a single Cloudflare Worker (ADR-0001, ADR-0009, ADR-0014). Not a service, not a monorepo, not microservices. One deployable the user owns.

```
                         ┌─────────────────────────────────────────────┐
                         │              ONE CLOUDFLARE WORKER            │
                         │                                              │
  scheduler alarm ─────▶ │  ┌────────────┐   ┌──────────────────────┐   │
                         │  │  Plugins   │──▶│        KERNEL         │   │
  (Ed API, Moodle,       │  │ (ingest)   │   │                      │   │
   RSS, any source)      │  └────────────┘   │  normalize → Item    │   │
                         │   Tier1 manifest   │  + facets            │   │
                         │   Tier2 code       │  change detection    │   │
                         │                    │  → Events            │   │
                         │                    │  job registry        │   │
                         │                    │  notifier            │   │
                         │                    │  retention           │   │
                         │                    └──────────┬───────────┘   │
                         │                               │               │
                         │                          ┌────▼─────┐         │
                         │                          │    D1    │         │
                         │                          └────┬─────┘         │
                         │        ┌──────────────────────┼────────────┐  │
                         │     ┌──▼───┐          ┌────────▼───┐   ┌────▼─┐│
                         │     │ MCP  │          │ dashboard  │   │  IM  ││
                         │     │ (v1) │          │  (later)   │   │ bot  ││
                         │     └──┬───┘          └────────────┘   └──────┘│
                         └────────┼────────────────────────────────────── ┘
                                  │
                         user's own Claude / ChatGPT client
```

- **Kernel** — source-agnostic core. Owns the Item + facet model, change detection, the job registry, the notifier, and retention. The product *is* the kernel.
- **Plugins** — bring sources. Ingestion-only (ADR-0018): fetch + map to Items/facets, nothing downstream.
- **Surfaces** — three thin faces over the kernel (ADR-0009). MCP first (v1); dashboard and IM bot later. No surface owns business logic.

---

## 3. The data model: generic Item + optional typed facets

(ADR-0016) Every record is a **generic Item**. Plugins optionally attach **typed facets**; facets optionally declare **capabilities** that bind fields to behavior **primitives** (ADR-0019/0020).

```
Item {
  id          # stable, plugin-scoped
  source      # which plugin/source produced it
  kind        # plugin-declared, free-form ("thread", "assignment", "email"…)
  title
  timestamp   # canonical time for ordering
  url
  body        # text/markdown
  raw         # original payload, kept for reprocessing
  facets[]    # zero or more typed facets
}

Facet {
  type            # free-form ("deadline", "submission", "thread"…)
  data            # arbitrary fields
  capabilities[]  # bindings of data fields onto behavior primitives
}
```

### Behavior primitives — the finite kernel surface

The one thing that is small, fixed, and carefully designed (ADR-0020). Capabilities are unbounded and dynamic; they *bind onto* these five:

| Primitive | A field is… | Unlocks | campus example |
|-----------|-------------|---------|----------------|
| `temporal` | a point in time | offset reminders, change-is-event, calendar/timeline | assessment `due_at` |
| `state` | a value in a set | transition-is-event, notify-on-transition | submission status; read/unread |
| `relation` | a reference to another item | threading, grouping | forum reply → thread |
| `actor` | a person/entity | filter/group by actor | post author (staff vs peer) |
| `scalar` | a number | threshold alerts, trend | grade, unread count |

A new domain need (`has-grade`) is normally a *declaration* onto `scalar` + config — **no kernel change**. Kernel code changes only if a genuinely new primitive is ever required, which is rare by construction.

v1 ships primitive validation, primitive-typed change Events, temporal queries, confirmed relations, and generic MCP access to every facet. Configurable reminder offsets, transition targets, and scalar thresholds are policy features after v1; the primitive model is their stable substrate, not a claim that every policy UI already exists.

---

## 4. The ingestion → surface lifecycle

One scheduler cycle (an hourly self-renewing Durable Object alarm, ADR-0021):

1. **Fetch** — each enabled plugin pulls from its source. Auth per plugin (Ed token direct; Moodle session cookie + derived sesskey, ADR-0003).
2. **Normalize** — plugin maps raw payload → Items (+ facets + capability bindings). Tier-1 plugins run a declarative manifest; Tier-2 plugins run code.
3. **Diff** — kernel compares against the last snapshot per Item.
4. **Events** — differences become Events, typed by the primitive that changed: a `temporal` field moving = "deadline shifted"; a `state` transition = "status changed"; a new Item = "new".
5. **Jobs** — enabled agent jobs (ADR-0008) react: daily digest, post triage, etc. These consume LLM quota under budget caps.
6. **Notify / serve** — the notifier (ADR-0010) pushes what crosses a threshold; surfaces serve queries and reads.

Steps 1–4 are **LLM-free** (ADR-0004). If every LLM path is exhausted, step 5 degrades to "skip + notify" and data freshness is unaffected.

---

## 5. Plugins in detail (ADR-0017, ADR-0018)

A plugin declares only: **identity, auth, fetch, mapping, emitted facets**. Two tiers, both compiled into the one Worker:

### Tier 1 — declarative manifest
For the many sources that are "hit an endpoint, map fields." A manifest (stored in D1, addable without redeploy) describes source, auth kind, fetch spec, and a field→Item/facet mapping. **AI is the killer feature**: an agent reads a sample response and generates the mapping — the user says "connect this API," the agent writes the plugin. Covers REST/RSS/JSON.

### Tier 2 — in-repo code
For sources needing real logic — OAuth dances, Moodle's sesskey flow, HTML parsing. Implements the Plugin interface in TS, compiled in, added by PR + redeploy. **Campus is Tier 2.**

**Not in scope (deferred v3+):** dynamic third-party sandboxed plugins. That needs Workers for Platforms (paid) and a trust/security model that is its own project.

### The campus plugin
The flagship Tier-2 plugin bundling Ed + Moodle. Reimplements the small API subset it needs in TS (ADR-0002) — Moodle is clean AJAX JSON (`/lib/ajax/service.php`), not scraping. It emits facets like:
- assignment/assessment → `temporal` (`due_at`) + `state` (submission status when explicit, otherwise `unknown`) + `scalar` (grade when the source payload exposes one)
- forum post → facet with `relation` (thread) + `actor` (author) + `state` (read/unread)

Monash's enabled timeline AJAX method currently exposes deadlines and action availability but not authoritative grades or enough information to distinguish every submitted/closed case. unicorn therefore never guesses: ambiguous submission state is `unknown`, and no grade facet is emitted without a numeric source value. Richer grade retrieval needs a supported JSON endpoint and remains outside v1.

Cross-platform course matching (same course in Ed and Moodle) is proposed by the user's MCP agent and confirmed by the user (ADR-0005), now expressed as a `relation` linking Items across sources.

---

## 6. LLM layer (ADR-0004, ADR-0007, ADR-0008)

All job code talks only to the **Vercel AI SDK interface**. Providers are swappable instances behind it:

```
job → AI SDK interface → OpenAI-compatible BYOK provider → skip without affecting ingestion
```

- **BYOK** = an OpenAI-compatible provider configured through `AI_API_KEY` and `AI_BASE_URL`.
- **Subscription providers** remain an end-state experiment, not v1 code. Their unofficial protocol and account-risk surface do not belong in the stable ingestion path.
- **Degradation** = a missing or failed model marks only the job as skipped/failed. Data freshness never depends on it.

**Agent jobs** live in a registry (ADR-0008): each has an enable toggle, a UTC schedule hour, a credential preference, and metered usage. Budget is three-layer: real metering → measured current-month projections → a preflight-enforced hard monthly cap that auto-pauses and notifies on breach (never ingestion). End-state catalog: daily digest, Ed↔assessment association, real-time post triage, study planning, extensible.

---

## 7. Storage & retention (ADR-0011)

D1 (SQLite) holds Items, facets, Events, the plugin registry, the job registry + usage ledger, and course/relation mappings. Secrets (tokens, cookies, keys) live in CF Secrets, not D1 (ADR-0013).

Retention: current data is **hot**; non-course Items older than the configured window are flagged **archived** and excluded from normal lists. An Item pulled again becomes hot before retention is re-evaluated. A single user won't pressure the 5GB free tier for years; this is about keeping queries and change detection scoped, not about space.

---

## 8. Auth & secrets (ADR-0003, ADR-0013)

- **Ed** — API token, used directly from the Worker.
- **Moodle** — session cookie pushed from the user's machine after a local `okta` login; the Worker keep-alives it (a periodic dashboard GET refreshes both the session and the sesskey). Session death is rare (weeks); the user re-pushes. Optional opt-in full-auto re-login (password + TOTP in Secrets + Browser Rendering) is later.
- **Secrets** — credentials are Cloudflare Worker Secrets, set through Wrangler or deployment automation. The Worker only reports whether each binding exists; it never renders values and deliberately cannot mutate its own secrets (ADR-0022).

---

## 9. Surfaces (ADR-0009, ADR-0010)

- **MCP server (v1)** — query + write-back for the user's own agent: "what's due," "what changed," propose/confirm course mappings, connect a new Tier-1 plugin. The user's Claude/ChatGPT does the reasoning; unicorn serves data. This is how "Claude/Codex account access" is satisfied for interactive use with zero chat UI to build.
- **Web dashboard (later)** — read-only timeline. v1 already includes a password-protected operator settings page for non-secret behavior and connection status.
- **IM bot (later)** — proactive push + light Q&A, over the pluggable notifier (Telegram / Discord / email).

Onboarding: Wrangler provisions the Worker and D1, secrets are pushed without entering the repository, and course mapping plus Tier-1 source installation go through the MCP agent.

---

## 10. What v1 actually ships

The sharp, finite first cut — kernel + campus, not "everything":

- Kernel: Item + facet model, the five primitives, change detection → Events, retention.
- Campus plugin (Tier 2): Ed (token) + Moodle (keep-alive), emitting temporal/state/relation/actor/scalar facets.
- Plugin engine: Tier-2 code path working; Tier-1 manifest engine at least minimally, since it's the "海纳百川" proof.
- LLM layer via AI SDK: OpenAI-compatible BYOK, with the daily digest disabled until explicitly configured.
- Job registry with metering + hard caps; daily digest as the first job.
- Authenticated MCP surface, Discord notifier, operator settings page, retention, and a self-renewing scheduler alarm.

**Deferred:** dashboard, IM bot, full subscription-provider breadth, Moodle full-auto re-login, dynamic third-party plugins, Ed↔assessment auto-association beyond simple relation.

---

## 11. Build results and remaining bets

1. **Moodle auth works from Workers.** `/my/` refreshes the session and yields `sesskey`; `npm run moodle:push` moves the local Okta session into the Worker without printing it.
2. **The five primitives survived a non-campus source.** A live RSS/Atom Tier-1 plugin ingests through the same kernel without new behavior code.
3. **The manifest and MCP surfaces are concrete.** D1 stores validated JSON/RSS manifests; MCP exposes item, upcoming, change, relation, manifest, job, and memory tools.
4. **The resident agent's organs are built (ADR-0023/0024/0025).** A budget-capped triage job runs deterministic reflexes first and calls a model only for the ambiguous middle; a capped notes memory (`get_memory` / `update_memory`) persists judgments; every outbound message flows through a durable outbox with idempotency keys and bounded retry, so a retried cycle never double-sends.
5. **Two push channels beyond Discord (ADR-0010).** Telegram and Resend email adapters resolve from whichever secrets are present; the `/digest` route serves the latest digest as a rendered HTML report (ADR-0026).
6. **Onboarding is one command (ADR-0027).** `npm run setup` orchestrates login → D1 create → migrate → secrets → deploy → schedule; `SETUP.md` documents the same path for coding agents.
7. **Moodle session lifetime remains empirical.** The scheduler now supplies real hourly keep-alive evidence; only elapsed time can close this question.
8. **Dynamic sandboxed code plugins and subscription-token providers remain deliberately deferred.** Both add trust or account-risk systems far larger than their v1 value.
9. **Monash grade enrichment remains endpoint-limited.** The enabled AJAX API does not expose authoritative grades or complete submission state, so v1 preserves `unknown` rather than manufacturing certainty.
