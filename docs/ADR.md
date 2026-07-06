# Architecture Decision Records — unicorn

Status legend: **Accepted** = decided in the grilling session on 2026-07-06.

---

## ADR-0001 — Deployment model: single-user self-deploy template

**Status:** Accepted

**Context.** "Users fully deployed on Cloudflare free accounts." Two readings: a template each user deploys to their own CF account, or a multi-tenant service we operate.

**Decision.** Single-user self-deploy template. Each user one-click-deploys their own Worker + D1 to their own free CF account. We maintain code, not a service.

**Consequences.**
- BYOK and subscription tokens are trivially the *user's own* credentials in *their own* Worker secrets — no tenant isolation, no encrypted multi-tenant key vault.
- Moodle session cookies are per-user and private by construction.
- No user accounts, no auth system, no shared free-tier quota contention.
- The trade-off: no central operation means no cross-user features and each user bears their own setup.

---

## ADR-0002 — Worker runtime & client code: pure TypeScript, reimplement the needed subset

**Status:** Accepted

**Context.** The Worker needs Ed and Moodle API access. `edstem-cli/client.py` is a thin REST wrapper (~533 lines); the Moodle side we need is timeline/assessment calls, but `moodle-cli` carries ~1700 lines of scraper/parser/BeautifulSoup logic. Options considered: reuse Python via CF Python Workers, or rewrite in TS.

**Decision.** Pure TypeScript Worker. Reimplement only the subset of API calls actually needed (Ed: courses/lessons/threads; Moodle: timeline + keep-alive). Python CLIs remain independent for local/agent use.

**Rationale.** CF Python Workers are beta with heavy limits (no full requests/httpx, C-extension gaps, Browser Rendering is a Puppeteer JS API). Betting the core product on that is the wrong risk. If Moodle only needs the timeline AJAX API (no scraping fallback), the actual rewrite is far smaller than 1700 lines.

**Consequences.**
- Two client implementations to maintain (Python CLI + TS Worker), but each is thin.

**Validation (2026-07-06, resolved).** Inspected `moodle-cli`. The concern "Moodle has no API" is half-right: the *token* webservice (`/webservice/rest/server.php`) is usually disabled by schools. But `moodle-cli` doesn't scrape for the data we need — it calls Moodle's own internal front-end JSON API at `/lib/ajax/service.php` (session cookie + `sesskey` auth). Everything on the v1 track is clean JSON:
- `core_calendar_get_action_events_by_timesort` → timeline/ddls (`get_todo`, [client.py:227](../../moodle-cli/moodle_cli/client.py:227))
- `core_course_get_enrolled_courses_by_timeline_classification` → course list
- `mod_forum_get_discussion_posts` → forum posts

Only **course contents** (`_scrape_course_contents`, [client.py:222](../../moodle-cli/moodle_cli/client.py:222)) uses BeautifulSoup, and it's off the track-assessment path. So the TS rewrite is a thin `POST /lib/ajax/service.php?sesskey=X&info=Y` wrapper + a few methodnames + JSON parsing — the 708-line scraper is essentially unused. The rewrite is far smaller than the "1700 lines" this ADR originally feared.

**Residual risk (moved, not closed).** The cost shifts from *parsing* to *auth*: `sesskey` is bound to the logged-in session and must be kept fresh alongside the session cookie. The real spike is no longer "can we get the data" (yes, JSON) but "how long does session cookie + sesskey survive CF cron keep-alive, and how often must the user re-push" — which is exactly the ADR-0003 keep-alive line.

---

## ADR-0003 — Moodle auth: layered keep-alive with optional full-auto

**Status:** Accepted

**Context.** Moodle has no long-lived token path here; auth is Okta SSO via `okta-auth` (Playwright + TOTP, headless-capable locally, **not** runnable inside a Worker — no browser, and Okta Verify push-only schools can't be automated at all). CF cron *can* keep an existing session cookie alive cheaply.

**Decision.** Layered:
1. **Default (keep-alive):** user logs in once locally via `okta`, pushes the resulting cookie to the Worker with one command; Worker cron keep-alives it. Session death is a rare event → notify user to re-push (weeks apart).
2. **Opt-in (full-auto):** user may store password + TOTP secret in Worker secrets and let a future Browser-Rendering flow re-login unattended. User chooses their own security level.

**Consequences.**
- v1 ships the keep-alive layer only; full-auto is later and gated behind explicit opt-in.
- Never forces credentials-in-cloud; the safe path is the default.
- Push mechanism (a `moodle sync --push <worker-url>` style command or a small script) is a required deliverable on the CLI side. **Open:** decide whether it lives in `moodle-cli` or a standalone script.

**Mechanism (2026-07-06, resolved from code).** `sesskey` is not JSON — it's extracted from the dashboard HTML (`_ensure_session` → `parse_page_context(DASHBOARD_PATH)`, [client.py:154](../../moodle-cli/moodle_cli/client.py:154)). This is the Worker's one residual HTML parse, but it's a single regex for the `sesskey` value, not the 708-line scraper. It also determines the keep-alive mechanism: `sesskey` is bound server-side to the session, so a periodic `GET /my` (dashboard) does double duty — it keeps the session cookie warm **and** yields a fresh `sesskey` for subsequent AJAX calls. One cron tick, both jobs. The user pushes only the session cookie; the Worker derives `sesskey` itself on each tick.

---

## ADR-0004 — Server-side LLM: Worker stores subscription tokens, with degradation chain

**Status:** Accepted (with recorded risk)

**Context.** The end goal is OpenClaw-style breadth: connect as many subscription plans as OpenClaw connects, the same way it connects them — not just BYOK. Server-side automation (daily summaries, agentic annotation) needs a model.

**Decision.** Worker stores subscription tokens in secrets and calls the model on the user's plan quota. Degradation chain for reliability:

> **subscription token → BYOK API key → skip LLM step + notify**

Refresh failure or a rejected token auto-falls-back to a user-configured API key; if none, the LLM step is skipped (data still ingests normally) and the user is notified. **The data pipeline never fails because of an LLM outage.**

**Risk register (explicit).**
- Subscription-token use against unofficial endpoints carries ToS and fingerprint-detection risk; provider header/fingerprint changes can break it without warning. Accepted knowingly; the degradation chain is the mitigation that keeps the product functional when it breaks.
- Follow OpenClaw's connection method per provider as the reference implementation.

**Consequences.**
- Data ingestion (Ed/Moodle → D1 → Events) is fully decoupled from LLM availability.
- BYOK must be built as a first-class fallback, not an afterthought.

---

## ADR-0007 — LLM provider layer: Vercel AI SDK interface + custom subscription providers

**Status:** Accepted

**Context.** End-state needs OpenClaw-breadth provider coverage. Options considered: hand-rolled per-provider adapters, depending on OpenClaw's provider layer as a library (rejected: designed for persistent Node/local runtimes, extraction cost ≥ writing our own), or Vercel AI SDK.

**Decision.** All job code talks only to the **Vercel AI SDK interface** (`generateText` etc., Workers-native).
- **BYOK layer:** official AI SDK providers (Anthropic, OpenAI, Google, OpenRouter, DeepSeek, any OpenAI-compatible) — free breadth, zero maintenance.
- **Subscription layer:** two self-written custom AI SDK providers, `claude-subscription` and `codex-subscription`, implementing OAuth refresh + official-client-mimicking fetch (protocol reference: OpenClaw's implementation, code our own, Workers-compatible). Community packages like `ai-sdk-provider-claude-code` don't work — they spawn CLIs, Workers has no subprocess.
- Degradation chain (ADR-0004) becomes provider-instance swapping: `job → AI SDK → [claude-subscription | codex-subscription | any BYOK provider] → skip + notify`.

**Consequences.**
- The fragile part (subscription mimicry) is quarantined inside two small provider packages; when providers change fingerprints, only those packages change — job code untouched.
- Subscription coverage is deliberately narrow (Claude + Codex only); breadth comes from BYOK.

---

## ADR-0008 — Agent Job framework: pluggable registry with metering and hard budget caps

**Status:** Accepted

**Context.** End-state server-side agent duties (daily digest, Ed↔assessment association, real-time post triage, study planning, and more later) must be user-selectable, not hardcoded features. User requires accurate token accounting.

**Decision.** Agent Jobs are entries in a **job registry**: each job has an enable/disable toggle, its own schedule, a model/credential preference, and metered usage. Budget control is three-layer:
1. **Metering:** every LLM call's real `usage` (from API responses) is logged to D1 per job.
2. **Estimation:** projections are measured-data-backfilled ("this job used X tokens last week, projected Y/month") — not static guesses, since post length varies too much for a static table to be honest.
3. **Hard cap:** user sets a monthly ceiling (tokens or $). On breach, LLM jobs auto-pause and notify; the data pipeline (ingestion → D1 → Events) keeps running regardless.

**Job catalog (end-state, all user-selectable, none hardcoded-on).**
- **Daily digest** — new-post summaries + upcoming ddls + change alerts, one readable digest/day. Highest value density; the main subscription-quota consumer.
- **Ed post ↔ assessment association** — when a new Ed post mentions an extension / correction / added requirement, the agent identifies it and attaches it to the matching assessment; important changes escalate to a push. This is the core "tame the chaos" value.
- **Real-time post triage** — after each pull, judge which posts are important (staff announcements, high-value answers) and push immediately rather than waiting for the daily digest. High call frequency, heavy quota consumption — off by default.
- **Proactive study planning** — suggest a schedule from ddls + workload. Accuracy-sensitive; risks spray-of-suggestions, so gated behind explicit opt-in.
- **Extensible:** the registry is open; more jobs can be added without touching the framework.

**Consequences.**
- "User-selectable + accurate token estimation" is satisfied structurally: toggles + measured metering + hard caps.
- LLM budget exhaustion never kills data freshness (consistent with ADR-0004 degradation chain).
- **Open:** default-on set for a fresh deploy (leaning: daily digest on, everything else off).

---

## ADR-0005 — Data model: unified Course / Assessment / Event; agent-proposed cross-platform matching

**Status:** Accepted, then **generalized by ADR-0016**. Course/Assessment/Event are no longer the universal schema — they are facets the campus plugin declares over the generic Item model. The cross-platform matching decision below still holds *within the campus plugin*.

**Context.** Multi-course, multi-platform (Ed + Moodle). Same real course appears in both with different names/ids ("COMP1234" vs "Intro to Programming").

**Decision.** Unified D1 schema: one `courses` table (cross-platform mapping to one real course), one `assessments` table (`source` field marks origin), one `events` table (change timeline). Cross-platform course matching is **proposed by the user's MCP-client agent** (it reads both course lists, suggests mappings, writes them back via an MCP tool) and **confirmed by the user**. No server-side heuristic matcher, no server-side LLM for matching.

**Consequences.**
- Clean MCP queries ("what haven't I submitted, when is it due").
- Keeps the Worker LLM-free for querying and matching — matching intelligence lives in the client agent the user already pays for.
- Change detection and assessment tracking are first-class (rules out the "store raw JSON blobs" shortcut).
- **Open:** the exact MCP tool surface for propose/confirm mapping needs specifying.

---

## ADR-0006 — v1 scope, ingestion cadence, and onboarding

**Status:** Accepted

**Decisions.**
- **v1 face = MCP server** (+ cron engine + D1). Web dashboard and IM (Telegram/Discord) bot are v2/v3. This consumes the "Claude or Codex account access" requirement for interactive use — the user connects from their own client, zero chat UI to build.
- **Tracking semantics (v1):** ddl calendar + change detection (Moodle timeline → assessments, diff snapshots for new/rescheduled/status-changed) **and** submission-status monitoring. Ed-post-to-assessment association is deferred (needs matching logic).
- **Ingestion cadence: user-configurable per source.** No fixed schedule baked in; frequency stored in config. Single-user volume sits comfortably inside CF free tier regardless.
- **Onboarding: Deploy-to-Cloudflare button + settings page.** README button provisions Worker + D1; the Worker serves a minimal password-protected settings page for token/frequency/subscription credentials, writing to D1/secrets. Course mapping goes through the MCP agent. Non-technical users can complete setup without a terminal.

**Consequences.**
- v1 deliverables: TS Worker with cron ingestion (Ed token + Moodle keep-alive), unified D1 schema, MCP endpoint, settings page, Deploy button.
- Deferred: IM bot, web dashboard, Ed↔assessment association, Moodle full-auto re-login, local runner fallback.
- **Open risks carried forward:** Moodle timeline reachability without scraping (ADR-0002); cookie-push command home (ADR-0003); MCP mapping tool surface (ADR-0005).

---

## ADR-0009 — Surfaces: shared kernel, three faces

**Status:** Accepted

**Context.** End-state has three surfaces: MCP server (v1), web dashboard (v2), IM bot (v3). Risk is duplicating change-detection / dedup / push logic across them.

**Decision.** The **cron engine + D1 + job registry is the single source of truth**. Surfaces are thin faces over it:
- **MCP** — query + write-back interface for the user's own agent (course-mapping proposals, "what's due", etc.).
- **Web dashboard** — read-only visualization (assessment timeline, unread posts) + the settings page.
- **IM bot** — proactive push channel + lightweight Q&A.

All three read/write the same tables; no surface owns business logic.

**Consequences.** Adding a surface is adding a face, not reimplementing the core. Push/dedup/change-detection live once, in the kernel.

---

## ADR-0010 — Notification channel: pluggable notifier abstraction

**Status:** Accepted

**Context.** Daily digest, important-post alerts, and imminent-ddl reminders all need an outbound channel. Single-user self-deploy, no server ops.

**Decision.** A `notifier` interface with built-in adapters: Telegram bot, Discord webhook, email (Resend / MailChannels). User fills their own webhook/token in the settings page. The IM-bot surface (ADR-0009) reuses this same layer.

**Consequences.** Users pick their channel; adding a channel is one adapter. Cost is writing a few adapters up front.

---

## ADR-0011 — Data retention: hot current term, cold archive

**Status:** Accepted

**Context.** D1 free tier is 5GB; a single user won't hit it for years, but unbounded history slows queries and change-detection scans and mixes dead courses into active ones.

**Decision.** Active data (current-term courses / assessments / events) stays hot. Past-term data is flagged `archived` — still queryable, excluded from cron pulls. Post bodies may be reduced to metadata after expiry.

**Consequences.** Queries and change-detection stay scoped to the current term. Clean architecture without a real space pressure.

---

## ADR-0012 — Platform extensibility: source-adapter abstraction, two sources first

**Status:** Accepted, then **subsumed by ADR-0017/0018**. The source-adapter idea grew into the full two-tier plugin model; "adapter" ≈ a Tier-2 code plugin. Kept for history.

**Context.** "Campus toolkit" implies aggregation beyond Ed + Moodle (Canvas, Gradescope, Blackboard, email, timetables…).

**Decision.** Define a **source-adapter interface**: `fetch → normalize to Course/Assessment/Event`. v1 implements only Ed + Moodle. Later platforms are one adapter each; the kernel and unified data model (ADR-0005) don't change.

**Consequences.** The adapter interface must be designed general enough up front to absorb future sources without kernel churn — the one place where a bit of up-front generality is warranted. Everything downstream (jobs, surfaces, retention) is source-agnostic by construction.

---

## ADR-0013 — Secrets: CF Secrets baseline, sensitive items quarantined

**Status:** Accepted

**Context.** The Worker must hold subscription OAuth tokens, optional Moodle password + TOTP, and the Ed token. Single-user self-deploy means the threat model is "the user's own CF account is secure" — acceptable. But CF Secrets are plaintext-readable to anyone with API access, and leakage via logs / error echoes is the real risk.

**Decision.** Layered:
- **Baseline:** all credentials in CF Secrets (threat model = user's own CF account). No client-held master-key encryption — cron is unattended, so a decryption key would have to live in Secrets anyway; zero net gain, added complexity.
- **Quarantine for the most sensitive (subscription tokens, Moodle password):** isolated in dedicated secrets and inside the dedicated provider packages (ADR-0007). Never logged, never echoed back, settings page is **write-only** for these fields (accepts input, never renders the stored value).

**Consequences.** Leakage surface (logs, error responses, settings-page reads) is closed for the high-value credentials. Baseline stays simple.

---

## ADR-0014 — Repository structure: single flat repo, no workspaces

**Status:** Accepted

**Context.** unicorn has several conceptual parts (kernel, source adapters, surfaces, custom subscription providers). Question: split into multiple repos, a workspace monorepo, or one flat package.

**Decision.** One flat repo, `TuuHub/unicorn`, single package. Kernel, adapters, and surfaces are folders, not packages. No pnpm/npm workspaces yet.

**Rationale.**
- The product is **one Cloudflare Worker, one deployable** (ADR-0001, ADR-0009). Dashboard, settings page, and IM-bot webhook are routes/handlers in the same Worker, not separate services. Multi-repo for a single deployable is pure coordination overhead for a solo dev — cross-repo version alignment, cross-repo PRs, duplicated CI — with no payoff.
- Source adapters normalize to unicorn's own Course/Assessment/Event model (ADR-0005); they have no reuse value outside unicorn, so they don't justify package boundaries.
- The **only** genuinely independently-reusable unit is the custom subscription providers (`claude-subscription`, `codex-subscription`, ADR-0007) — general AI SDK providers useful to anyone. When they prove out, they should become their **own top-level repos** (not sub-packages of unicorn), extractable via `git subtree split`. Pre-splitting now is paying interest on a future hypothesis.

**Consequences.**
- Simplest possible structure until a real second publishable unit exists.
- Workspaces get adopted only when/if the subscription providers are extracted — the moment that need is real will be obvious.

---

## ADR-0015 — Product reframe: AI-native information aggregation platform; campus is the flagship plugin

**Status:** Accepted (reframes ADR-0006 scope; campus remains v1's sharp edge)

**Context.** The campus toolkit is really one instance of a broader thing: an AI-native information aggregation platform where sources arrive as pluggable plugins. The design center of gravity is the plugin system — "how to accept everything" (海纳百川).

**Decision.** unicorn is a **plugin platform first**. Ed/Moodle become the **official flagship plugin bundle** used to dogfood the kernel. v1 still ships the campus plugin working end-to-end (keeps a real pain point pulling on the design), but the kernel API is designed for *arbitrary sources* from line one.

**Rationale.** "Aggregate all information" is a gravity well that kills side projects — no concrete pain to steer design. The live version of the reframe is "platform is the product, campus is the proof": build a general ingestion kernel, prove it against a real chaos (assessment tracking). "AI-native" is not marketing — it's the mechanism (below) that lets the schema stay loose because an LLM supplies structure at read time, so the platform can sit further toward "generic" than a traditional aggregator could.

**Consequences.**
- ADR-0005 (rigid unified Course/Assessment/Event) is generalized by ADR-0016; those types become facets the campus plugin declares, not the universal schema.
- ADR-0012 (source-adapter) is subsumed by the fuller plugin model (ADR-0017/0018).
- Scope discipline: v1 = kernel + campus plugin, not "everything." Breadth comes from plugins added later, not from v1 boiling the ocean.

---

## ADR-0016 — Universal data model: hybrid generic Item + optional typed facets

**Status:** Accepted (generalizes ADR-0005)

**Context.** A platform that accepts everything can't force all sources into a rigid schema (Course/Assessment/Event fits campus, not email/RSS/GitHub/etc.). But a fully generic blob makes the platform unable to *do* anything — tracking, change detection, and cross-source reasoning need structure. The spectrum's tension: **more generic = less the platform can do for you.**

**Decision.** Hybrid. Every record is a **generic Item** (`id, source, kind, title, timestamp, url, body, raw`). Plugins may attach **optional typed facets** (e.g. `deadline`, `thread`, `grade`). Structured features light up when a facet is present; records with no facet still store fine. The LLM supplies missing structure at read time (the AI-native lever from ADR-0015).

**Consequences.**
- 海纳百川 (generic base) and actual usefulness (facets) coexist instead of trading off.
- ADR-0005's Course/Assessment/Event become facets the campus plugin declares — not a universal schema.
- Facets are the contract between plugins and platform features (see ADR-0018).

---

## ADR-0017 — Plugin runtime: two tiers (declarative manifests + code plugins); no dynamic sandbox in v1

**Status:** Accepted (subsumes ADR-0012)

**Context.** What *is* a plugin technically, under single-deployable (ADR-0001), single-repo (ADR-0014), free-tier, self-deploy constraints? Rejected up front: dynamic third-party sandboxed plugins (need Workers for Platforms — paid — plus a trust/security model that is its own project; deferred to v3+), and one-Worker-per-plugin (violates single deployable).

**Decision.** Two tiers, both running inside the one Worker:
- **Tier 1 — declarative plugins (manifest).** Most sources are "hit an API, map fields to Item/facets." A manifest declares source, auth kind, fetch spec, and field→Item/facet mapping; a generic engine runs all manifests. **AI is the killer feature here:** an agent reads a sample response and generates the mapping — the user says "connect this API" and the agent writes the plugin. Covers REST/RSS/JSON APIs. Install = add a manifest, no code.
- **Tier 2 — code plugins (in-repo TS).** For sources needing real logic (Moodle's `sesskey` dance, OAuth flows, HTML parsing). Implement the Plugin interface, compiled into the Worker, added via PR + redeploy. Campus is Tier 2.

**Consequences.**
- 海纳百川 is achieved mostly through Tier-1 declarative manifests + AI-generated mappings, not a risky dynamic sandbox.
- Both tiers honor single-deployable and free-tier self-deploy.
- **Deferred (v3+):** dynamic third-party plugin loading (Workers for Platforms + trust model).

---

## ADR-0018 — Plugin contract: ingestion + facet declaration only; downstream is facet-driven

**Status:** Accepted

**Context.** Does a plugin only ingest (fetch + map → Item/facets), or does it also bundle its own jobs and notification logic? This is the line that decides whether "platform" is real.

**Decision.** Plugins are **ingestion-only**. A plugin declares: identity, auth, fetch, mapping, and **which facets it emits** — nothing more. Change detection, tracking, agent jobs (ADR-0008), notifications (ADR-0010), and retention (ADR-0011) all operate **generically over Items + facets** at the platform level. A plugin emitting a `deadline`-capable facet inherits ddl-reminder behavior for free, zero downstream code.

**Rationale.** Facets are the contract; the platform binds behavior to facets, not to plugins. The alternative (plugins bundle jobs) recreates "每个插件各自为政" — logic duplication, the kernel stops being a kernel, and facets earn nothing.

**Consequences.**
- Adding a source is: emit the right facets → inherit all platform capabilities.
- The kernel stays a kernel; plugins stay thin.

---

## ADR-0019 — Facet vocabulary: open facets, behavior bound to declared capabilities

**Status:** Accepted

**Context.** If facets are the plugin↔platform contract, who defines them? Closed vocabulary (platform-predefined) guarantees behavior works but forces novel sources down to generic Items — against 海纳百川. Fully open facets are infinitely extensible but a facet with no platform handler does nothing structured.

**Decision.** **Open facets, with platform behavior bound to declared *capabilities*, not facet names.** A facet declares standard capabilities (e.g. `has-deadline` with a `due_at` field, `has-unread`, `has-thread`); the generic tracker / notifier / change-detector binds to any facet declaring that capability — regardless of whether it's named `deadline`, `exam`, or `renewal`. Novel facets with no standard capability still store fine; the LLM reasons over them at read time (ADR-0015 / ADR-0016).

**Consequences.**
- Openness and usefulness stop fighting: vocabulary is open, behavior attaches to capabilities.
- **Refined by ADR-0020:** capabilities are *not* a fixed built-in list either. A capability is a dynamic declaration binding a facet field onto one of a small fixed set of **behavior primitives**. The finite, carefully-designed kernel surface is the *primitive* set, not a capability list — capabilities stay unbounded and dynamic.

---

## ADR-0020 — Behavior primitives: the finite kernel surface; capabilities bind to them dynamically

**Status:** Accepted (refines ADR-0019)

**Context.** ADR-0019 said "the capability set is the kernel API surface to design up front." That conflated two layers. A challenge surfaced it: why can't capabilities be whatever plugins declare, dynamically? They can. The distinction:
- **Declaration layer** — fully dynamic. A plugin declares any facet with any capabilities/fields; zero kernel change.
- **Behavior layer** — needs code. For the platform to *do* something (remind before a time, treat a change as an event, render a calendar), something must know what a field means.

The insight: the behavior layer can also be dynamic, if the kernel ships a small set of **generic behavior primitives** and a capability is a *binding* of a facet field onto a primitive — instead of one hardcoded handler per capability.

**Decision.** The kernel ships **five behavior primitives**. A capability is a dynamic declaration mapping facet field(s) onto a primitive. `has-deadline`, `has-exam-date`, `has-event-start` are three declarations against the *one* temporal primitive — not three handlers.

| Primitive | A field is… | Platform behavior unlocked | campus use |
|-----------|-------------|----------------------------|------------|
| **temporal** | a point in time | offset reminders, change-is-event, timeline/calendar render | deadlines, calendar |
| **state** | a value in a state set | transition-is-event, notify-on-transition-to-X | submission status, read/unread (2-state) |
| **relation** | a reference to another item | threading, grouping | forum threads, course membership |
| **actor** | a person/entity | filter/group by actor | author (staff vs peer) |
| **scalar** | a number | threshold alerts, trend | grade, unread count, price |

**Consequences.**
- The finite, deliberately-designed kernel surface is **these five primitives** — few, irreducible, cross-domain. Capabilities above them are unbounded and dynamic.
- A new domain capability (e.g. `has-grade`) is usually just a declaration onto `scalar` + a threshold config — no kernel change. Kernel code changes only if a genuinely new *primitive* is ever needed (rare by construction).
- Notification content is generic templating or AI-generated; reminder cadence is user-configurable per facet — none of it is hardcoded per capability.
- This is the concrete "AI-native lets the schema stay loose" mechanism: primitives give structured behavior where fields bind; the LLM covers everything unbound at read time.
