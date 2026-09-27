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

**Status:** Accepted, then **amended by ADR-0026** — the web-dashboard face is demoted to rendered reports and IM is upgraded to the primary conversational face; the shared-kernel principle stands. Kept for history.

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
- **Delivery boundary:** v1 implements validation, primitive-typed Events, temporal queries, confirmed relations, and generic facet access. Per-facet reminder cadence, transition targets, and scalar threshold policies follow after v1; they build on these primitives without changing plugin contracts.

---

## ADR-0021 — Scheduling: self-renewing Durable Object alarm

**Status:** Accepted (refines ADR-0006's cron mechanism)

**Context.** Cloudflare cron triggers are limited at the account level, and the deployment account already uses every slot. Deleting another product's trigger or requiring a paid plan would violate single-user self-deploy. The scheduling mechanism is not part of the plugin contract; only reliable periodic execution matters.

**Decision.** A singleton `Scheduler` Durable Object owns an alarm. Starting it schedules an immediate cycle; every alarm executes the source → kernel → retention → optional job pipeline and re-arms itself for one hour later in `finally`. Protected `POST/GET/DELETE /schedule` controls and inspects it.

**Consequences.** unicorn remains one Worker and runs automatically without consuming an account cron slot. Alarm state is durable and failures cannot prevent re-arming. Per-source cadence remains deferred; v1 uses one hourly cycle for every enabled source.

---

## ADR-0022 — Settings and secrets: status only, no self-mutation

**Status:** Accepted (corrects ADR-0006/0013's settings mechanism)

**Context.** A Worker cannot write its own Cloudflare Secrets without holding a high-privilege Cloudflare API token. Giving the application that token to save users one setup command would enlarge the blast radius far beyond the source credentials it protects.

**Decision.** Credentials enter through Wrangler or deployment automation and remain Worker Secrets. The settings page may show only whether bindings exist; it edits non-secret D1 configuration such as retention and enable toggles. It never renders secret values and never stores credentials in D1.

**Consequences.** First deploy retains a short CLI step, but the Worker never holds authority to rewrite its own deployment. Moodle session push is automated by `npm run moodle:push`, which pipes the cookie directly from `okta-auth` to Wrangler.

---

## ADR-0023 — Product reframe: unicorn is a resident agent; the kernel is its body

**Status:** Accepted (extends ADR-0015; promotes the jobs layer from periphery to product center)

**Context.** With the maintained dashboard rejected and MCP reading as "just a tool server," the product looked like an accessory to someone else's agent. The missing observation: an MCP-only unicorn is passive (answers only when asked) and amnesiac (client sessions forget). Meanwhile ADR-0004/0007/0008/0021 had already built the organs of an agent — server-side LLM with a degradation chain, providers, a budget-capped job registry, a durable scheduler. The question was never "can it be an agent" but "is the agent the product."

**Decision.** unicorn is a **resident secretary agent** running on the user's own free Cloudflare account. Its v1 mandate is exactly one job: **triage** — watch every facet event, suppress noise, speak only when something matters, and remember every correction. Anatomy:

- **Body (thick — the moat):** plugin runtime, deterministic zero-LLM ingestion, facet model, change detection, scheduler. Generic agent frameworks cannot replicate this cheaply: their perception is browser-and-scrape; ours is structured pipelines inside free quota, including authenticated sources behind SSO (ADR-0003).
- **Brain (thin — deliberately commodity):** an event-driven loop. Deterministic rules run first (a new deadline within 7 days is always important; no material change is dropped); a cheap model sees only the ambiguous middle; a better model handles planning/digest. Every call sits behind ADR-0008 budget caps, and the degradation chain guarantees perception survives brain death.
- **Coalescing:** facet events are debounced in a window (~10 min) so one bulk edit becomes one triage call and at most one notification. "Never spam" is a product invariant enforced structurally, not by prompt.

**Rationale.** The loop is commoditizable — any Hermes/OpenClaw-style framework rebuilds it in a weekend. The body is not. Effort distribution therefore stays roughly 9:1 body:brain, and every new feature passes the **weekend test**: if a generic framework could copy it in a weekend, keep it thin; if not, that is where unicorn invests. Because the kernel also serves external brains (ADR-0026's MCP face), unicorn degrades gracefully into "their best sensor pack" even if resident loops lose to generic frameworks — betting on the body means the brain war is won either way.

**Consequences.**
- Reasoning stays split: the resident loop performs short reflexes only; open-ended multi-step reasoning belongs to the user's own client via MCP. No server-side multi-turn agent loop.
- Memory becomes a real design surface → ADR-0024.
- Surfaces re-rank around the agent → ADR-0026.
- Triage judgment quality is the product's life-line; precision work on it is roadmap, not polish.

---

## ADR-0024 — Agent memory: dual substrate — facts in D1, judgment in capped notes; no vectors

**Status:** Accepted

**Context.** An agent that remembers corrections needs memory beyond world state. Candidate substrates: relational rows, a vector store, plain notes. The deciding question is **who reads it**.

**Decision.** Two substrates, split by reader:

- **World state** (what is true out there): structured Items/facets/Events in D1 (ADR-0016). The reader is the machine — change detection is a SQL diff and notifications fire at exact times; that cannot cron off prose.
- **Agent memory** (what unicorn believes about the user's world): **one markdown notes document** (optionally split by domain: preferences, per-course patterns) stored in D1, read in full on every reasoning call, and writable through an MCP tool so the user's own agent can persist judgments ("this course's quizzes don't count"). Two resident write paths exist, both narrow: a **corrections inbox** — replies to the Telegram bot are captured verbatim (zero-LLM) as dated entries in a `corrections` domain the triage judge reads next cycle — and **consolidation**: near the cap a budget-capped model call compresses the notes (merges duplicates, distills raw corrections into rules, drops obsolete entries). The resident loop never authors judgments beyond what the user literally said. The reader is the LLM — prose is its native format, and judgments are irregular enough to resist schema.
- **A hard token cap** on the notes (~4k, enforced across all domains combined). At 80% of the cap the resident consolidation pass compresses automatically; at the cap, writes fail with consolidation guidance. Forced forgetting is hygiene: it keeps density high enough that reading everything every time stays the correct strategy.

**Vectors are rejected** for both potential uses:
1. *Agent memory:* retrieval is probabilistic — a judgment that fails to be retrieved re-spams the user silently, which is fatal for a never-spam secretary. The corpus is KB-scale and fits in context; retrieval where full-read is possible is strictly information loss. Wrong memories must be findable and editable — open the note, fix the line; a vector store offers neither.
2. *Corpus search:* structured queries answer most questions (deadlines are fields, not similarity targets), keyword matching covers single-user term-scale data, and the MCP client filters candidates natively. Embeddings would also insert a model call into the zero-LLM ingestion path, violating ADR-0015's LLM-optional principle.

**Reversal condition.** Vectors may return only as an optional retrieval plugin (never in the ingestion path) when the archived corpus outgrows what an agent can read **and** keyword queries demonstrably fail real questions.

**Consequences.**
- Memory is fully auditable: the user can read and edit everything the agent believes.
- No embedding-model dependency, no index maintenance, no new budget line.

---

## ADR-0025 — Runtime form: event-driven serverless is load-bearing; capability ladder for heavier work

**Status:** Accepted (stress-tests ADR-0001/0021 against the agent mandate)

**Context.** Resident-agent frameworks are long-lived daemons on a VPS or local machine. Does the agent reframe (ADR-0023) force that form? The deciding variable is **duty cycle**: unicorn's secretary reacts for seconds per hour and idles otherwise — the textbook profile for event-driven serverless. Auditing free-tier limits against single-user load, everything (requests/day, D1 quotas, DO limits, memory) has 100×+ headroom; the single real wall is per-invocation CPU time (~10 ms on free). LLM calls are subrequest I/O and burn no CPU.

**Decision.** unicorn stays a single event-driven Worker. Daemonization is rejected: it pays for an always-on machine that idles 99.9% of the time, adds ops and attack surface, and — decisively — exits the free account that is unicorn's identity (ADR-0001). "Generic frameworks cannot run in this cost structure" is the moat reading of that constraint.

Long work is **step-chaining, not a process**: agentic tasks are discrete checkpoints (each LLM call is a natural breakpoint), state lives in the DO/D1, and alarms chain the steps (ADR-0021). What a Worker genuinely cannot do reduces to a real browser and a shell, handled by a **capability ladder**:

1. **Free core (non-negotiable):** ingestion, triage loop, step-chained tasks, and Browser Rendering within its free daily allowance for automated re-auth (upgrades ADR-0003's full-auto option; the laptop `moodle:push` peripheral remains the zero-dependency fallback).
2. **Paid muscle (optional plugin):** Cloudflare Containers for shell-grade work — scale-to-zero burst compute attached to a DO, not a daemon, so it does not break the form. The core never depends on it.
3. **Relief valve:** Workers Paid raises the CPU wall from 10 ms to 30 s with zero architecture change. The free tier is design discipline; paid is a valve, never the foundation.

Three engineering rules are **v1 foundations, not optimizations**, because they are how the design clears the CPU wall and stays trustworthy under retries:
- **Per-source step-chaining.** Each source syncs in its own invocation: subrequest and CPU budgets reset, and one source's failure cannot cascade.
- **Notification outbox.** Events flow through an outbox table and are delivered with idempotency keys and retry. A secretary that double-sends the same reminder loses trust instantly.
- **Lazy bodies.** Hot-store metadata + facets only; fetch full bodies on demand (when triage flags an item or MCP queries it).

**Reversal condition.** The daemon question reopens only if the mandate ever requires hours of *continuous* stateful work per day — in-process state that cannot be checkpointed (a live browser session, a shell environment) rather than mere task length.

**Consequences.**
- The wall's failure signal is explicit: single-step CPU kills in logs *after* chaining and lazy bodies → chain finer first, then open the valve.
- The architecture is tier-portable: scaling up is configuration, not migration — the structural advantage over the daemon form, where outgrowing the machine means moving house.

---

## ADR-0026 — Surfaces: pull/push two faces around the agent; UI is output, not asset

**Status:** Accepted (amends ADR-0009; ADR-0010's notifier layer is unchanged)

**Context.** ADR-0009's three faces predate the agent reframe. A maintained web dashboard duplicates what any MCP client renders on demand; a daily-driver CLI duplicates what MCP clients (Claude Code included) already are. Generated views are near-free in the LLM era; maintained views are inventory that rots.

**Decision.** Two faces over the kernel:

- **Push / converse — IM (primary face).** Telegram/Discord via ADR-0010 notifiers, upgraded from a delivery channel to a *conversational surface*: the user talks to unicorn where the pushes arrive, and it answers with memory (ADR-0024) and world state. Webhooks fit the Worker natively — ack fast, work in the background.
- **Pull — MCP.** Reframed from "the product" to "the port where other brains consult unicorn": the user's own Claude/agents pull structured, compact, filtered tool responses. Tool design *is* the context engineering — tools return projections, never dumps.

Web is demoted to **rendered reports**: `/settings` (exists, ADR-0022) plus `/digest` — HTML written at digest time, served as-is, linked from notifications. Zero framework, zero client state: an output artifact, not a surface.

Explicitly not built: a maintained dashboard; a daily-driver CLI (the setup installer is excluded — ADR-0027); ACP support (an agent-to-client protocol is coherent now that unicorn *is* an agent, but it is deferred until an editor-facing use case exists — MCP + IM cover every current consumer).

**Consequences.**
- Every MCP-speaking agent — and transitively every ACP-speaking client those agents plug into — becomes a unicorn interface for free; protocol-ecosystem growth accrues to the kernel.
- ADR-0009's core ("adding a surface is adding a face") stands; only the roster changed.

---

## ADR-0027 — Onboarding: one in-repo setup script, shared by humans and agents

**Status:** Accepted (completes ADR-0006's onboarding sketch; upholds ADR-0022's no-self-mutation)

**Context.** Self-deploy is currently a README command list (login, D1 create, jsonc edit, migrate, secrets, session push, deploy, schedule start). Every manual step is an abandonment point. There are two audiences: humans in a terminal, and coding agents (Claude Code) told "deploy this."

**Decision.** One **in-repo installer**: `npm run setup` — a single linear Node script orchestrating: prerequisite checks → `wrangler login` → `d1 create` (capture `database_id`, write it back to `wrangler.jsonc`) → migrations → generate random `ADMIN_TOKEN`/`MCP_TOKEN` and feed `wrangler secret put` → optional `moodle:push` → deploy → `POST /schedule`. Wrangler runs as a child process with inherited stdio, so its own interactive flows (browser OAuth) pass through untouched — no PTY tricks solving a problem that does not exist. A `SETUP.md` documents the same path for agents: the cloning user says "deploy me" and the agent runs the same script. One path, two audiences.

Rejected for now: a published `npx create-unicorn` package. Deploy already requires the cloned repo (migrations, `wrangler.jsonc`), and publishing adds template-download machinery for zero current external users. Revisit when a real second deployer exists — it is an hour of wrapping then.

**Consequences.**
- Onboarding collapses to `git clone` + one command (+ the unavoidable browser OAuth).
- The installer is disposable glue, not a maintained surface — it does not violate ADR-0026's no-CLI stance.
- Secrets still enter only through Wrangler (ADR-0022 upheld).

---

## ADR-0028 — Resident brain: Pi behind a narrow runtime seam

**Status:** Accepted (supersedes ADR-0007's Vercel AI SDK choice and amends ADR-0023's prohibition on server-side multi-turn loops)

**Context.** ADR-0023 correctly kept the resident brain thin, but its blanket rejection of a server-side multi-turn loop also blocked the conversational IM surface promised by ADR-0026. The existing one-shot `TextGenerator` is enough for digest and triage; it is not enough to answer a follow-up question, call several Unicorn tools, stop safely, resume with history, or expose one consistent loop to HTTP and Telegram. Cloudflare OS now runs `pi-agent-core` inside Workers, removing the runtime-compatibility uncertainty while leaving persistence and product policy to the host.

**Decision.** unicorn uses `@earendil-works/pi-ai` for model transport and `@earendil-works/pi-agent-core` for bounded conversational tool loops. Pi is the brain implementation, not the Unicorn kernel. The external `ResidentAgent` interface contains only `run(turn)` and `reset(conversationId)`; Pi contexts, messages, tools, provider events, and replay details stay inside that module.

The production-default provider is the native Cloudflare Workers AI binding. A small fetch adapter translates its non-streaming text/tool response into the OpenAI event stream already consumed by Pi, so no Cloudflare account token is stored inside the Worker. An explicit `AI_API_KEY` and optional `AI_BASE_URL` take precedence for BYOK deployments. Provider selection remains behind the same runtime seam.

The resident loop is deliberately narrower than a general-purpose agent:

- Read-only Unicorn tools expose compact D1 projections for items, upcoming deadlines, changes, memory, and sync status.
- No arbitrary network, SQL, shell, code execution, plugin installation, settings mutation, or source-side write is available.
- Durable Object routing serializes turns per conversation; D1 stores messages, idempotent turn results, and measured job usage.
- A bounded recent-history window is replayed. Old rows remain auditable without entering every prompt.
- Provider failure, timeout, budget exhaustion, and loop exhaustion are explicit domain failures. Ingestion remains independent.

The existing `TextGenerator` interface stays as the one-shot seam for digest, triage, and memory consolidation, with a Pi adapter replacing the AI SDK adapter. This keeps those deep modules unchanged and prevents Pi types from spreading through the codebase.

**Consequences.**

- ADR-0007's provider implementation changes from Vercel AI SDK to Pi, while its provider-isolation intent remains.
- ADR-0023 now permits bounded multi-turn reasoning for direct user conversations; scheduled triage stays a deterministic-first one-shot judge.
- ADR-0026's Telegram converse face becomes real without weakening MCP as the port for external brains.
- `nodejs_compat` becomes part of the Worker runtime contract and must be verified by Wrangler dry-run and production smoke tests.
- Workers AI becomes a first-class Worker binding; no model secret is required for the default edge deployment.
- Pi version changes are explicit upgrades, not floating dependency updates, because message and event semantics sit on a persistence seam.

---

## ADR-0029 — Product: unicorn is the agent, the harness is the product, users bring their own client

**Status:** Accepted (2026-09-16; supersedes ADR-0023's "no server-side multi-step reasoning" and its 9:1 body:brain rule; extends ADR-0028)

**Context.** Mounting Ed, Moodle, OnTrack and an email MCP separately into a client agent does not work in practice: 60+ source-shaped tools, no cross-source join, and the client model rarely plans a multi-source query on its own. The three jobs the user actually wants are not one-shot lookups:

1. **Plan the week** — a cross-course to-do for the next 7 days that knows which emails to search (extension, reschedule, due) and asks back when the data is ambiguous.
2. **Assignment reminder and decomposition** — when an assessment enters its due window, read its spec, split it into tasks, and lay them out day by day.
3. **Staff forum brief** — what teaching staff said on the forum since the last brief, delivered wherever the user's agent runs.

All three need a strong model running a bounded multi-step loop over persistent state, plus a scheduler that acts when nobody is asking. Several alternative shapes were considered and rejected in the same session: a query-time "meta-MCP" that routes among N mounted MCP servers (tool-selection just moves down a level, tokens and latency double); a zero-LLM cache with course-shaped tools and `query(sql)` (cannot plan a week or split an assignment); a template ladder / JSON plan DSL for weak client models (the use cases need reasoning, not form-filling); LLM-written scripts in Dynamic Workers (paid, beta).

**Decision.** unicorn is the agent. The user's own client (Claude Code, Claude Cowork, a Grok bot, Hermes, anything that speaks MCP) is a thin front; unicorn does the reasoning server-side with the user's own model credentials. Three commitments:

- **Brain is first-class.** The Pi loop (ADR-0028) becomes the product surface. It runs up to a dozen tool turns per request, drives itself from **playbooks** (ADR-0031), and owns durable **plans** and **briefs**. A capable BYOK model is the recommended production configuration; the native Workers AI binding remains the zero-secret default and the degradation path, not the design target.
- **Body stays.** Hourly ingestion into D1, change detection, capped memory and the scheduler are unchanged (ADR-0015 – ADR-0025). They exist so the brain never re-fetches four sources per question and can answer "what changed", which no client session can.
- **Harness is the investment.** Playbooks, tool projections, memory, plan state, budget caps and scheduled triggers are the analogue of a coding agent's skills, tools, memory and hooks. That is where new effort goes; new sources are plugins (ADR-0017, ADR-0033), not new reasoning code.

**Consequences.**
- ADR-0023's weekend test still applies to the body; the brain is exempt because the value is in the playbooks and state, which are unicorn-specific.
- The MCP surface for clients shrinks to a door (ADR-0030); the IM converse face is retired (ADR-0032).
- Token cost lives in unicorn's ADR-0008 ledger under one job (`resident-agent`), never in the client.

---

## ADR-0030 — Door: a two-tool MCP front for client agents, a separate admin MCP for operators

**Status:** Accepted (amends ADR-0026's MCP face)

**Context.** The existing `/mcp` exposes ~15 kernel-shaped tools (items, events, relations, manifests, jobs, memory). That is the right surface for an operator, and the wrong one for a client agent that should just hand the question over. Tool count in the client's context is the whole problem ADR-0029 exists to solve.

**Decision.** Two MCP endpoints on the same Worker:

- **`POST /mcp` — the door** (bearer `MCP_TOKEN`). Exactly four tools:
  - `ask({ question, conversationId? })` → `{ answer, toolsUsed, usage }`. Runs one resident-agent turn (ADR-0028 seam) through the per-conversation Durable Object. `conversationId` defaults to `"mcp"`; clients may pass their own to keep separate threads.
  - `get_briefs({ unreadOnly? = true, limit? = 20 })` → `[{ id, kind, subject, title, body, createdAt, readAt }]`, newest first.
  - `ack_briefs({ ids })` → marks briefs read.
  - `remember({ text })` → appends a dated line to the `corrections` memory domain verbatim (zero-LLM; replaces the Telegram `/remember` command).
  The server's `instructions` field tells the client: call `get_briefs` at the start of a session and whenever the user asks what is new; route every question about courses, deadlines, forums, email or planning to `ask`; never answer those from its own knowledge.
- **`POST /mcp/admin` — the operator surface** (bearer `ADMIN_TOKEN`). The existing tool set unchanged (`list_items`, `get_item`, `list_upcoming`, `list_changes`, relations, manifests, agent jobs, memory). Operators and setup agents use it; client agents never mount it.

`POST /agent` (ADR-0028) stays as the raw HTTP form of `ask` for scripts.

**Consequences.**
- A client sees four tools and one sentence of instructions; the 60-tool problem is gone by construction.
- `ask` is synchronous. The turn budget is 55 s wall (under the default MCP client timeout) with the loop capped by ADR-0031's turn limit; a timeout is an explicit `timed_out` error, never a partial answer presented as complete.
- `mcp-server.test.ts` splits into door and admin suites; the door suite proves the four tools and the instructions text.

---

## ADR-0031 — Playbooks: procedures are the harness; plans and briefs are durable state

**Status:** Accepted

**Context.** ADR-0028's loop has four read tools, four turns and a generic system prompt. It can answer "what is due", not "plan my week". The missing pieces are procedure (what to gather, what to search, when to ask back, what to output), richer tools shaped for those procedures, and state that outlives one turn.

**Decision.**

**Playbooks.** A playbook is a markdown procedure bundled in the Worker (`src/agent/playbooks/*.md`, imported as text) with a small header: `id`, `title`, `trigger` (`on-demand`, `daily`, `weekly`, or `assessment-due-window`), and `output` (`answer` or `brief`). Three ship in v1:

| id | trigger | output | procedure summary |
|----|---------|--------|-------------------|
| `weekly-plan` | on-demand; also `weekly` (Monday, at the resident job's `schedule_hour_utc`) | brief | List courses. Pull deadlines for 14 days with submission status, open OnTrack-style tasks, staff posts for 7 days, and emails matching due / extension / reschedule / exam / quiz. Rank by due date and effort. Lay out 7 days. If two deadlines collide or a spec is missing, say what is unknown and ask one question. Output: per-day checklist plus a "needs your input" list. |
| `decompose-assignment` | `assessment-due-window` (an assessment enters 7 days to due, is not submitted, and has no plan yet) and on-demand | brief + plan | Read the assessment body, the course's staff posts that mention it, and emails that mention it. Split into 3–7 concrete tasks with an estimated hour each. Spread across the days left, lighter on weekends per memory. Save as a plan keyed by the assessment. Output the plan. |
| `forum-brief` | `daily` (at `schedule_hour_utc`) and on-demand | brief | For each active course, staff-authored threads (author role `staff`/`admin`, or thread type `announcement`, or pinned) since the last forum brief. Group by course. One line per thread: what changed for the student, with the link. Skip courses with nothing. Empty result → no brief. |

Playbook text is part of the system prompt for every `ask` turn (three procedures fit in about a thousand tokens), so the model follows the matching procedure when the question calls for it and answers directly otherwise. Scheduled runs invoke one playbook explicitly through a `PlaybookRunner` that runs an ephemeral loop (no conversation history) and stores the result as a brief.

**Tools.** The resident tool set grows to fit the procedures, all read-only on sources:
`list_courses`, `get_course_overview(course)` (identity, assessments with status, recent staff posts, emails mentioning the code, whether an OnTrack-style task source exists), `search_items(query, kind?, course?, since?)` (D1 `LIKE` over title and body, projection only), `get_item(source, itemId)` (full body), `list_upcoming`, `list_changes`, `list_staff_posts(course?, since?)`, `list_memory`, `get_sync_status`, `get_plan(kind, subject)`, `save_plan(kind, subject, content)`, `remember(text)`. The loop limit rises from 4 to 12 turns; the wall budget is 50 s. Tool results stay projections (ADR-0026).

**State.** Two tables, both single-user and unbounded only by retention:
- `plans(id, kind, subject, content, created_at, updated_at)` — `kind` is `weekly` or `assignment`; `subject` is an ISO week or `source item_id`. One current row per (kind, subject).
- `briefs(id, kind, subject, title, body, created_at, read_at)` — `kind` is `weekly-plan`, `assignment-plan`, `forum-brief` or `digest`. The existing daily digest writes its output here too so `get_briefs` is the one inbox.

**Budget.** All Pi usage — `ask` turns and scheduled playbooks — is metered under the existing `resident-agent` job (ADR-0008). A scheduled playbook that would exceed the cap is skipped with a logged reason and a one-line brief saying so; `ask` fails with `budget_exhausted` as today.

**Consequences.**
- Playbook edits are the primary way to improve the product; they are reviewed like code and covered by tests that assert the prompt contains each procedure.
- Staff detection relies on the Ed thread payload (`user.role` / `type` / `is_pinned`); the Ed plugin gains an `authorRole` field on its `author` facet.
- Course attribution for items without a `course-membership` facet (emails) uses unit-code mentions (ADR-0033).
- Migrations: `0009_plans.sql`, `0010_briefs.sql`.

---

## ADR-0032 — Delivery: pull-only; the Telegram converse face is retired

**Status:** Accepted (amends ADR-0026; ADR-0010's notifier stays for operational alerts)

**Context.** ADR-0026 made Telegram the primary converse face because MCP was "just a tool server". With ADR-0029 the user talks to unicorn through their own agent, and an IM conversation loop is a second front to maintain for a user who is no longer the target. Push is still wanted for scheduled output, but MCP clients cannot receive pushes, and the user chose the simplest option: the client pulls.

**Decision.**
- `POST /telegram`, `src/telegram.ts` and `TELEGRAM_WEBHOOK_SECRET` are removed. `/remember` becomes the `remember` door tool; `/reset` is `DELETE /agent`.
- Scheduled playbook output and the daily digest are **briefs** (ADR-0031), read through `get_briefs` and acknowledged through `ack_briefs`. The door's instructions ask clients to pull briefs on session start.
- The notifier and outbox (ADR-0010, ADR-0025) are kept for what they are good at: operational alerts (sync failures, budget exhausted) and the existing triage pings. They no longer carry conversational content. Telegram remains available there as one channel among three.

**Consequences.**
- A T-7 reminder is seen when the user next opens their agent; for a student that is daily and was judged acceptable.
- One brain, one door, no second loop to keep in sync with it.
- SETUP and README drop the Telegram bot setup for conversation and keep it under notifications.

---

## ADR-0033 — Remote MCP servers as ingest sources; Gmail through Google's official MCP

**Status:** Accepted

**Context.** The user's paradigm is "plug an MCP in". ADR-0029 rejected doing that at query time; doing it at ingest time fits ADR-0017's Tier-1 model exactly: a manifest names a remote MCP server, one tool, fixed arguments, and a field mapping, and the hourly cycle calls it like any other declarative source. Gmail is the first target: Google ships a remote Gmail MCP at `https://gmailmcp.googleapis.com/mcp/v1` with `search_threads` / `get_thread`, authenticated by OAuth against the user's own Google Cloud OAuth client (no dynamic client registration). Monash student mail is Google Workspace, so Gmail is the campus email source, and a self-deploy (ADR-0001) means each user's own OAuth client in testing mode needs no Google verification.

**Decision.**
- The declarative manifest gains a transport: `{ "transport": { "type": "mcp", "url", "tool", "arguments", "auth" } }`, where `auth` is either the existing `PLUGIN_SECRET_*` bearer binding or `{ "type": "oauth", "provider": "google" }`. The plugin is a Streamable HTTP MCP **client**; it calls the one tool, takes `structuredContent` (or parses the first text content as JSON), and applies the existing `itemsPath` + mapping language. Everything else in the manifest is unchanged, so `install_plugin` on the admin MCP accepts it.
- **OAuth** is a one-time browser dance from `/settings`: `GET /settings/oauth/<pluginId>/start` redirects to the provider, `GET /settings/oauth/callback` exchanges the code and stores the refresh token in D1 (`oauth_tokens(plugin_id, provider, refresh_token, access_token, expires_at, scope, updated_at)`). Client id and secret live in Worker Secrets (`PLUGIN_SECRET_GOOGLE_CLIENT_ID`, `PLUGIN_SECRET_GOOGLE_CLIENT_SECRET`); ADR-0022 holds because the Worker never mutates its own secrets — the refresh token is application state in the user's own D1, like the Moodle session would be if it were not a secret. Access tokens are refreshed on demand.
- A **Gmail preset manifest** ships in-repo (`src/plugins/presets/gmail.json`) and is installable in one click from `/settings`: `search_threads` with `query: "newer_than:14d"` and `pageSize: 50`, kind `email`, facets `author` (from sender) and `course-mention` (`codes`: unit codes matched by `/\b[A-Z]{3}\d{4}\b/` over subject and snippet, with a `relation` capability named `mentions-course`). The kernel provides the extractor so any source (RSS, other mailboxes) can declare the same facet.
- `get_course_overview` and `search_items` (ADR-0031) join emails to courses through `course-mention.codes` ↔ `course-identity.code`.

**Consequences.**
- Adding a source is a JSON manifest, again; existing edstem/moodle/ontrack MCP servers can be mounted the same way if their tools return JSON.
- Gmail cannot be exercised end-to-end in CI; the plugin is tested against a fake MCP server, the OAuth flow against a fake token endpoint, and the preset is validated against the manifest schema. First real-account verification is a deploy-time smoke step recorded in SETUP.
- Migration: `0011_oauth_tokens.sql`.

---

## ADR-0034 — Brain removed: unicorn is the memory layer; reasoning runs in the user's harness

**Status:** Accepted (2026-09-21; supersedes ADR-0029 and ADR-0028; retires the LLM layer of ADR-0004/0007/0008, the notifier of ADR-0010/0032, and the judgment-notes half of ADR-0024; amends ADR-0031)

**Context.** ADR-0029 put a Pi loop inside the Worker because, at the time, no client could act while the user was away. Two facts changed within a week of shipping it:

1. Harnesses now run strong models on a schedule and reach remote MCP servers from there — Claude Code routines and Cowork scheduled tasks through claude.ai connectors. "Nobody is asking" no longer requires a model in the Worker.
2. The sibling CLIs (Ed, Moodle, OnTrack) became remote MCP servers. The client can query live sources from any device, so unicorn is no longer needed for reach.

Meanwhile the in-Worker model layer was the least reliable component: the free Workers AI model leaked tool-call markup and skipped `save_plan`; BYOK meant paying twice for a model the user already pays for in the client; every brief row in production was model-produced, so the whole proactive story rested on the weakest part. The layer plus its outbox and notifier is about 4,800 lines including tests.

The question that survives is: **with every source mounted directly in the client, what can it still not do?** Exactly four things — remember (a baseline, so mutations are visible), join (one course across three systems), keep shared state (plans, briefs, labels reachable from any client and any routine), and render (a widget instead of prose). None needs a model in the Worker.

**Decision.** unicorn is the **memory layer** of the user's campus agent. Reasoning runs in the harness.

- **Delete** `src/agent/*` except the playbook markdown, the `ask` tool and `POST /agent`, the Workers AI / BYOK runtime, the model jobs (`daily-digest`, `triage`, `memory-consolidation`), the token ledger and caps, `src/notifier.ts` and `src/outbox.ts`. No degradation path is kept; a branch nobody tests is a liability.
- **Keep** the body unchanged: hourly ingestion, Items and facets, change detection, retention, the scheduler, the corrections memory behind `remember`. The judgment-notes memory domain (ADR-0024) is retired; buckets and labels (ADR-0036) replace it.
- **Replace** model-written briefs with a zero-LLM daily digest (changes since the last digest, deadlines in the next 7 days, staff posts) written once a day at 07:00 in the user's timezone and skipped when empty, and with `write_brief` for routines (ADR-0035).
- **Move** playbooks out of the Worker's prompt and into the client: they are served as MCP prompts and through `run_playbook` (ADR-0035) and executed by whichever model the user already runs.

The rule that settles every future "why not just mount it in Claude" question: **a source mounted in the client is live; the same source ingested by unicorn is memory. Both at once is the design, not a conflict.**

**Consequences.**
- About 4,800 lines removed; `src/runtime/cycle.ts` shrinks to ingest, diff, digest and retention. Tables from migrations 0005–0008 are dropped in a new migration; `plans` and `briefs` stay.
- ADR-0023's weekend test applies to the whole Worker again; there is no exempt brain.
- README and SETUP lose model configuration entirely; the first-run path has no AI credential of any kind.
- The ADR trail is the story: the loop was built, measured against harness-side scheduling, and removed. Knowing what to delete is the engineering claim.

---

## ADR-0035 — Door v2: state tools, MCP prompts, OAuth for connectors, user-defined SQL tools

**Status:** Accepted (2026-09-21; supersedes ADR-0030)

**Context.** The door exposes `ask`, `get_briefs`, `ack_briefs`, `remember`; the one capability nobody else has, "what changed", is reachable only by paying for an `ask` turn. Connectors on claude.ai and ChatGPT need OAuth: ChatGPT accepts OAuth or no auth only, and Claude's static-header option is a beta gated on an organisation admin. ChatGPT consumes tools only, no prompts or resources. Users want to shape their own tools without a redeploy and without running code in the Worker.

**Decision.**

**Tools.** The door (`/mcp`) exposes, all read-only on sources:

| tool | returns |
|---|---|
| `get_briefs`, `ack_briefs` | the durable inbox (unchanged) |
| `write_brief({ kind, subject, title, body, idempotencyKey })` | for routines; a repeated key is a no-op |
| `changes_since({ cursor?, limit? })` | `{ events[], nextCursor, counts }` — the lossless feed of ADR-0036; the server holds no client state |
| `course({ code })` | one course across every source, grouped by bucket |
| `life()` | the non-course buckets |
| `search_items({ query, kind?, course?, since? })` | FTS5 over title and body, ranked |
| `get_plan`, `save_plan`, `remember` | unchanged |
| `run_playbook({ name })` | `{ instructions, data }` — the playbook text plus the data it needs, for tool-only clients |
| `label_items([{ source, itemId, bucket, topic? }])` | the triage routine's write path |
| `status()` | last sync and error per source, no secrets |

Plus up to 20 **user-defined tools** (below). Server `instructions` tell the client to pull briefs on session start, to call `changes_since` when asked what is new, and to use `remember` on every correction.

**Prompts.** Each playbook is registered under `prompts/list` with the same markdown `run_playbook` returns. Contract for playbook text: door tools are required; source MCPs (Ed, Moodle, canvas-mcp, Gmail) are optional enrichment, and the procedure must complete without them. Four playbooks: `weekly-plan`, `decompose-assignment`, `forum-brief`, `triage`.

**Auth.** The Worker is an OAuth 2.1 authorization server via `workers-oauth-provider` with dynamic client registration on, since both Claude and ChatGPT register themselves. The consent page sits behind the existing `/settings` Basic auth; for a single-user deployment, logging in is entering `ADMIN_TOKEN`. The `MCP_TOKEN` bearer path stays for local Claude Code and development. Both credentials map to the door identity. The admin surface stays bearer-only.

**User-defined tools.** A tool is data, not code: `{ name, description, inputSchema, sql }`. Admin tools `define_tool`, `list_tools`, `delete_tool`, `describe_schema`; the door lists defined tools dynamically and emits `tools/list_changed`. Guards are mechanical: `SELECT` or `WITH` only, one statement, bound parameters, access limited to the views `v_items`, `v_upcoming`, `v_changes`, `v_courses`, `v_buckets`, an enforced `LIMIT 200`, an `EXPLAIN` at definition time, a cap of 20. Sharing is a GitHub repository (`unicorn-tools`) with an `index.json`: admin `browse_tools`, `install_tool`, and `publish_tool`, which returns a PR-ready payload for the user's agent to open with `gh`. No hosted registry.

**Client packaging.** A Claude Code plugin bundles the door's MCP config (token via `${CLAUDE_PLUGIN_OPTION_…}`), the playbooks as skills, a SessionStart hook that pulls briefs, and a `setup-routines` skill that creates the four routines through the harness's scheduler. ChatGPT is a tier-0 client: OAuth connector, `run_playbook`, widgets (ADR-0037); ChatGPT Tasks calling connectors is undocumented and offered as best effort. Cowork uses the connector plus its scheduled tasks.

**Consequences.**
- The door has about twelve fixed tools plus the user's own; `ask` and `POST /agent` are gone (ADR-0034).
- `mcp-door.test.ts` proves each tool, the prompts list, the OAuth metadata endpoints, and every SQL guard.
- ChatGPT Free cannot add connectors; Claude Free can. Onboarding docs say so.

---

## ADR-0036 — Change model and buckets: lossless events, five buckets, harness-side triage, term-aware course linking

**Status:** Accepted (2026-09-21; supersedes ADR-0005's agent-proposed matching; extends ADR-0016, ADR-0020, ADR-0033)

**Context.** Events today are `item.created`, `item.updated`, `capability.changed`. Archiving emits nothing; a moved deadline is buried in a `capability.changed` row the reader has to decode. The `relations` table exists but no read path consults it; courses are joined at query time by a code-prefix `LIKE`. Ed threads carry a category that students use as the unit of conversation ("Assignment 2"), and most of what students care about is posted by staff. Gmail ingests the whole inbox for 14 days. Regex classification of posts was rejected: it misses.

**Decision.**

**Events.** Typed by what a student would ask about, not by which column changed: `item.added`, `item.archived`, `item.restored`, `deadline.changed` (before, after), `state.changed`, `grade.changed`, `content.changed` (full before and after, never clipped), `notice.posted` (a staff post, with an optional `topic`). Every row carries a monotonic id (the cursor), `course`, `bucket`, `source`, `kind`, `url`. Events are never pruned; retention archives Items and emits `item.archived`.

**Buckets.** A two-level path stored on the Item: `course/<code>/<assignment>`, `course/<code>/general`, `life/events`, `life/admin`, `life/other`. Structured sources are labelled deterministically at ingest: assessments own their bucket; Ed threads land in the assignment bucket whose title matches their category, otherwise `general`. Free text (email, general forum posts) is labelled by the `triage` playbook running as a routine, through `label_items`, with `labeled_by` recording `structure`, `triage` or `client`. Unlabelled Items are still returned, flagged `unlabeled`, and the client model decides on the spot. No regex.

**Course linking.** A resolver, first hit wins: (1) a confirmed relation from `link_items`; (2) exact match on normalised code (uppercase, whitespace and `_S2_2026`-style suffixes stripped) with `term` when both sides carry one, falling back to the current active offering when one does not; (3) nothing automatic beyond that — `suggest_links` lists fuzzy title candidates for the user's agent to confirm. `course-identity` gains `term`. Assessment ↔ Ed category uses the same ladder on normalised titles. Ambiguity returns every match with `ambiguous: true`; the server never guesses.

**Gmail scope.** University domains, mail mentioning a course code, and a sender allowlist edited in `/settings`. Not the whole inbox.

**Consequences.**
- Migration `0012`: events v2, `bucket` / `topic` / `labeled_by` on Items, `term` on `course-identity`, an FTS5 table over title and body. Existing event rows are kept under their old types; the cursor starts at the current max id.
- The Ed plugin emits the thread category; the Canvas plugin (ADR-0038) emits `course_code` and term.
- `course()` and `life()` are views over buckets; `changes_since` is flat and lets widgets group.

---

## ADR-0037 — Widgets: MCP Apps resources, six widgets, text fallback, unicorn-state-only actions

**Status:** Accepted (2026-09-21)

**Context.** Both ChatGPT and Claude (web, desktop, mobile, on individual plans) render the MCP Apps extension: a tool result points at a `ui://` resource served as `text/html;profile=mcp-app`. Rendering has open reliability bugs on some desktop and Claude Code paths. The user's judgment: for a question a student asks every day, a good widget is more reliable than a page of prose.

**Decision.** Six widgets, one implementation for both clients, each a static HTML file bundled at build and served as a `ui://unicorn/<name>` resource:

| widget | tool | actions |
|---|---|---|
| brief card | `get_briefs` | `ack_briefs` |
| course view (buckets, expandable threads) | `course` | none |
| changes feed (grouped course → bucket) | `changes_since` | none |
| plan checklist | `get_plan` | `save_plan` |
| deadline timeline | `search_items` / upcoming | none |
| connection status | `status` | none |

Every tool result also carries its full text content; the widget is additive and the text is the fallback. Widget actions call door tools only and mutate unicorn state only: `ack_briefs`, `save_plan`, `remember`, `label_items`. A widget never writes to a source; posting to Ed or submitting to Canvas is the user's agent calling the source's own MCP.

**Consequences.**
- Build order: brief card, course view, changes feed; the rest after Canvas.
- Tests snapshot each widget's HTML and assert the text content is complete without it.
- Writing to sources from a widget would need its own security model and is out of scope by decision, not by omission.

---

## ADR-0038 — Canvas: Tier-2 ingest plugin; canvas-mcp is the live toolbelt; onboarding by source

**Status:** Accepted (2026-09-21; extends ADR-0017, ADR-0033)

**Context.** Canvas is the LMS most universities outside Monash run, students can mint their own personal access tokens, and Ed + Canvas is a common pairing (USyd, UNSW, Stanford, Berkeley). `vishalsachdev/canvas-mcp` is an active MIT FastMCP server with 102 tools, a `--role student` profile, a stateless HTTP mode that takes the caller's token per request, and no term or planner output. The Tier-1 manifest does one fetch with no pagination or fan-out, which Canvas needs. Blackboard has no personal-token path and is out.

**Decision.**
- **Ingest** is a Tier-2 plugin, `src/plugins/campus/canvas-plugin.ts`: courses (with `include[]=term`), assignments, the user's own submissions, announcements and discussion topics, Link-header pagination, configured by `CANVAS_BASE_URL` and `PLUGIN_SECRET_CANVAS_TOKEN`. It emits `course-identity` (code, term), assessments (temporal + state), staff posts (actor) and threads. Pagination and the course-code cache follow canvas-mcp's implementation.
- **Live** access is canvas-mcp's student profile, recommended in docs and named in playbooks as the optional enrichment source for Canvas users. unicorn does not call it for ingest: a cron that needs four GETs should not depend on a Python service the user has to keep alive.
- **Upstream**: a PR to canvas-mcp surfacing the term it already fetches.
- **Onboarding by source**: `/settings` gains a source form — pick a preset (Ed, Moodle, Canvas, Gmail), enter the base URL, paste the token (stored as a `PLUGIN_SECRET_*`, never through a model), capture the browser timezone, show last sync and errors. `npm run setup` asks which sources the user has and configures only those. The Canvas test bed is a Free-for-Teacher account. Piazza is the next candidate source.

**Consequences.**
- The campus plugin is Ed + Moodle + Canvas; Moodle stays the hard one (Okta), so a Canvas + Ed student onboards with two tokens and no browser session push.
- Canvas is marketed only after one real Canvas + Ed student has installed it.
- First external users are named friends, not a post; the post comes after three successful installs.

---

# Amendments — 2026-09-27

Six deviations and additions made while building ADR-0034–0038, recorded as their own ADRs rather than silently edited into the originals — the trail is the story (ADR-0034's closing line). Each below either extends its parent ADR's decision or documents where the shipped code took a different path, with the exact behaviour verified against source.

## ADR-0039 — Source credentials: AES-GCM in D1, keyed by ADMIN_TOKEN, env secrets take precedence

**Status:** Accepted (2026-09-27; amends ADR-0038's onboarding-by-source and ADR-0013/ADR-0022's secrets model)

**Context.** ADR-0038 says a pasted `/settings` token is "stored as a `PLUGIN_SECRET_*`, never through a model" — but ADR-0022 already established that the Worker cannot mutate its own Cloudflare Secrets. A token pasted into a browser form has nowhere in Secrets to land. The wave2/sources branch (`src/sources.ts`, `migrations/0014_source_credentials.sql`) resolves this the only way available: application state in the Worker's own D1.

**Decision.** A pasted credential is AES-256-GCM encrypted and stored in a new `source_credentials` table (`source_id`, `ciphertext`, `iv`, `updated_at`), never plaintext, never rendered back. The encryption key is never itself stored: it is derived on every use via HKDF-SHA256 (WebCrypto) from `ADMIN_TOKEN`, with a fixed, documented salt and info string (`unicorn/source-credentials/v1/salt` / `.../aes-256-gcm` — these don't need to be secret, only stable, so re-derivation always yields the same key bytes). A fresh random 12-byte IV is drawn per encryption and stored alongside the ciphertext.

Precedence is env-first: `resolveEdCredentials` / `resolveMoodleCredentials` / `resolveCanvasCredentials` (`src/sources.ts`) each call a `secretWins(envValue, stored)` helper that returns the env value whenever it's non-empty, falling through to the decrypted D1 value only when no Worker Secret is set. An existing production deploy with `ED_API_TOKEN` / `MOODLE_SESSION` / `PLUGIN_SECRET_CANVAS_TOKEN` already set is untouched by this feature — nothing pasted into `/settings` can override an operator-set secret.

**Consequence, verified in code.** `decryptFields` never throws; on any failure — including a wrong key after `ADMIN_TOKEN` rotation — it returns `null`, and `D1SourceCredentialStore.get` turns that into `{ status: "invalid" }` rather than `{ status: "ok" }` or a crash. `buildSourceStatuses` surfaces this as `needsReentry: true` on the source's `/settings` card. So: **rotating `ADMIN_TOKEN` makes every stored source credential permanently undecryptable** — not corrupted, not recoverable, genuinely a different key — and the student must re-paste each one. This is a real operational cost of rotating the admin password that ADR-0038 does not mention; document it wherever `ADMIN_TOKEN` rotation is discussed (see docs/UPGRADING.md).

**Consequences.**
- ADR-0038's "stored as a `PLUGIN_SECRET_*`" line is superseded by this ADR for anything entered through `/settings`; a `PLUGIN_SECRET_*` set via `wrangler secret put` still works exactly as ADR-0033 describes and always wins.
- Migration `0014_source_credentials.sql` is additive (one new table); no existing data is touched.
- `ADMIN_TOKEN` now has a second responsibility beyond authentication: it is key material. A password manager or secret rotation policy that rotates it on a timer must budget for re-entering every source credential afterward.

---

## ADR-0040 — Door: `upcoming` added past ADR-0035's tool list

**Status:** Accepted (2026-09-27; extends ADR-0035)

**Context.** ADR-0035's door table has no dedicated "what's due" tool — `search_items` and `changes_since` cover search and the change feed, but "what's due in the next two weeks across every course" needs either a `course()` call per course or a scan. Every playbook that plans time (`weekly-plan`, `decompose-assignment`) needs exactly this query, more than once, before any planning logic runs.

**Decision.** The door gained a fourteenth tool, `upcoming({ days = 14, course?, includeOverdue = false })` → items with a deadline in the window, ordered by due date, with an `includeOverdue` flag reaching back 90 days for missed deadlines. It renders through the same `deadlineTimeline` widget as `search_items` (shared `ItemList` shape) and shares its `Next:` suggestions with the playbook data-fetchers in `door.ts` (`weekly-plan` and `decompose-assignment` both call `repo.upcoming` directly rather than re-deriving the window from `search_items`).

**Consequences.**
- The door is 14 fixed tools, not ADR-0035's twelve-ish count (`get_briefs`, `ack_briefs`, `write_brief`, `changes_since`, `course`, `life`, `search_items`, `upcoming`, `get_plan`, `save_plan`, `remember`, `label_items`, `status`, `run_playbook`).
- Every doc that enumerates door tools (README, ARCHITECTURE §7, `docs/CONNECTORS.md` where relevant) must list `upcoming` or it silently undercounts.

---

## ADR-0041 — Widgets: a model-collaboration loop, not a dead end

**Status:** Accepted (2026-09-27; extends ADR-0037)

**Context.** ADR-0037 specified six static widgets with an action model limited to calling a door tool. Verified against the MCP Apps extension spec (SEP-1865, `specification/2026-01-26/apps.mdx`, read 2026-09-26) and ChatGPT's older, non-MCP-Apps host, a widget can do two more things that make it worth more than a card: hand the model a message, and tell the model what a completed action changed — without waiting for the user to type anything.

**Decision.** `src/widgets/bridge.js` implements both, gated by declared host capability rather than by guessing which host is running:

- **`ui/message` / `sendFollowUpMessage` handoff.** A widget button ("Discuss this", "Break this down") calls `ui/message` with a user-role text message, so the host relays it to the model exactly as if the user had typed it. ChatGPT's pre-extension Apps SDK never speaks this postMessage protocol at all — it injects `window.openai.sendFollowUpMessage` as a global instead — so `sendMessage()` checks for that function first and falls back to `ui/message` only when it's absent.
- **`ui/update-model-context` advisory updates.** After a widget action succeeds against unicorn's own state (e.g. checking off a plan item calls `save_plan`), the widget calls `ui/update-model-context` with a one-line factual summary. This is advisory only: it never expects or waits for a reply, and a host that rejects or doesn't support the call has the failure swallowed — the widget's own action already succeeded, so a failed advisory update must never present as an error.
- **Capability discovery, not brand detection.** Both calls are gated behind `hostCapabilities.message` / `hostCapabilities.updateModelContext` from the `ui/initialize` handshake result (`detectCapabilities()` in `bridge.js`); `window.openai.sendFollowUpMessage`'s mere presence also counts as message support. A host that declares neither capability gets the corresponding button hidden entirely — never rendered and disabled, never a click that silently does nothing.
- **A consistent tool contract underlies this**: every door tool's text output ends with a deterministic `Next:` line (`nextLine()` in `door.ts`) naming concrete follow-up calls, and every tool error returns both a text block (`Error (code): message\nNext: hint`) and `structuredContent: { error: { code, message, hint } }` (`errorResult()` in `door.ts`; the same `{code, message, hint}` shape is used by the user-tool guard's `ToolError`). A widget's `callTool()` wrapper and a client model parsing raw tool output both read the same shape.

**Consequences.**
- A widget is not required to degrade to "read-only card" on a capable host — it can genuinely continue the conversation.
- Capability gating means the same widget HTML ships to every host; there is no per-host build.
- The `Next:`/error-shape contract is now load-bearing for widgets as well as for text-only clients — changing it is a breaking change on two fronts, not one, exactly as door-contracts.ts's header comment already warns for `structuredContent`.

---

## ADR-0042 — User-tool SQL guard: hardened against comma-joins, wrap-escaping, and unbounded joins

**Status:** Accepted (2026-09-27; amends ADR-0035's user-defined tools)

**Context.** ADR-0035's guard description ("`SELECT`/`WITH` only, one statement, bound parameters, view-only access, forced `LIMIT 200`") describes the policy, not the implementation's adversarial coverage. Building it against actual adversarial SQL (not just well-formed mistakes) surfaced three gaps a naive token-after-keyword guard leaves open.

**Decision.** `src/tools/user-tools.ts`'s `validateSql` is a hand-rolled tokenizer (comments and string/quoted-identifier literals are stripped and recognized before any keyword check runs — the exact place naive regex guards get smuggled past) with four hardening passes past the original policy:

1. **Comma-joins are walked in full.** `FROM v_items, oauth_tokens` names a second table with no `FROM`/`JOIN` keyword in front of it. `validateFromList`'s loop walks the *entire* comma-separated reference list every `FROM`/`JOIN` introduces (`target [[AS] alias] (, target [[AS] alias])*`), so every named table gets the same allowed-view/CTE check, not just the first one.
2. **A view-reference cap** (`MAX_VIEW_REFERENCES = 6`) bounds how many times one statement may reference a view or CTE. `v_items` computes two correlated subqueries per row (`due_at`, `state`); an unbounded comma/cross join multiplies that cost combinatorially as a cartesian product *before* the outer `LIMIT 200` ever trims the output, so the cap exists independently of the row limit.
3. **The `LIMIT 200` wrap can't be escaped by parens or comments.** `wrapSql` splices the tool's SQL into `SELECT * FROM (<sql>) LIMIT 200`. A stray unmatched `)` closes that wrapper's own `(` early, which can turn the rest of `<sql>` — typically ending in a `--` line comment with no trailing newline — into text that swallows the wrapper's real `) LIMIT 200`, executing with whatever limit (or none) the attacker wrote. A paren-depth counter that must never go negative and must end at exactly zero closes this off structurally, independent of which token would otherwise carry the escape.
4. **`EXPLAIN` runs against the wrapped SQL at definition time**, with dummy bind values typed from the declared `inputSchema` (never executed against real data). A tool whose SQL is well-formed by the tokenizer but references a non-existent column, or is otherwise invalid, fails at `define_tool` time with SQLite's own error message quoted back — not at first call time.

Unchanged from the original policy and still enforced: `SELECT`/`WITH` only as the first token; no anonymous `?` parameters (named `:param` only, and every one must be declared in `inputSchema`); a forbidden-keyword list (`insert`, `update`, `delete`, `drop`, `pragma`, …) checked as bare tokens outside string literals; `sqlite_*` identifiers forbidden whether quoted or not; `load_extension(...)` and `pragma_*(...)` table-valued function calls forbidden; schema-qualified (`schema.table`) and table-valued-function FROM/JOIN targets forbidden.

**Consequences.**
- The guard's adversarial coverage is now proportionate to what it protects: a single-user D1 database reachable by any door client, including a stolen OAuth token scoped to `memory`.
- `MAX_VIEW_REFERENCES` is a genuine usability limit, not just a security one — a tool needing more than six view/CTE references is asked to narrow itself, per the guard's own error hint.
- Every guard rejection quotes the offending SQL fragment and states the fix, so a client model can repair its own SQL in one retry without a human in the loop.

---

## ADR-0043 — OAuth: Client ID Metadata Documents via global_fetch_strictly_public

**Status:** Accepted (2026-09-27; extends ADR-0035's OAuth authorization server)

**Context.** ADR-0035 specified dynamic client registration (DCR) as the way Claude and ChatGPT add unicorn as a connector. MCP's 2025-11-25 authorization update also supports Client ID Metadata Documents (CIMD): a client can use an `https://` URL as its own `client_id`, and the authorization server fetches that URL for the client's metadata instead of requiring a `/register` round trip. `@cloudflare/workers-oauth-provider` supports this behind an opt-in flag, but fetching an attacker- or client-supplied URL from inside the Worker is exactly the shape of a server-side-request-forgery risk (a `client_id` pointed at `http://169.254.169.254/...` or a private RFC 1918 address).

**Decision.** CIMD is enabled (`clientIdMetadataDocumentEnabled: true` in `createOAuthProvider`, `src/oauth-server.ts`), gated on the Worker-level `global_fetch_strictly_public` compatibility flag (`wrangler.jsonc`), which Cloudflare enforces at the fetch layer: every outbound `fetch()` from this Worker must resolve to a public address, never a private or loopback one, for any request the Worker makes — not just the CIMD metadata fetch. That makes it double as a baseline SSRF guard for every Tier-1 declarative manifest plugin's fetch (ADR-0017), which was otherwise one attacker-authored manifest URL away from probing internal addresses from Cloudflare's network.

**Consequences.**
- A client can add unicorn with an `https://` `client_id` and no registration step, alongside DCR (still on, capped at `MAX_REGISTERED_CLIENTS = 20`) and the static `MCP_TOKEN` bearer.
- The SSRF guard is Worker-wide and unconditional, not opt-in per plugin — a future manifest author gets it for free and cannot turn it off from a manifest.
- `compatibility_date` and this flag together are now load-bearing for both OAuth and plugin security; bumping the compatibility date in a future upgrade must not silently drop `global_fetch_strictly_public` from `compatibility_flags`.

---

## ADR-0044 — Injected clock: digest and upcoming bind `now`, never `julianday('now')`

**Status:** Accepted (2026-09-27; a testing/determinism convention, not a product decision)

**Context.** SQLite's `julianday('now')` reads the real wall clock inside the query itself, which makes any query using it untestable with a fixed date and non-reproducible across retries within the same logical cycle (two calls a millisecond apart can disagree on "now").

**Decision.** Every query that needs "now" — the daily digest's 7-day due-soon window (`src/digest.ts`'s `loadDigestSections`) and the door's `upcoming` tool (`src/mcp/door-repository.ts`) — takes `now: Date` as an explicit parameter from the caller (`deps.now ? deps.now() : new Date()` in `door.ts`; `runDailyDigest`'s caller in `runtime/cycle.ts`) and binds it into the SQL (`julianday(?)` against the bound ISO string), never calling SQLite's own `julianday('now')`.

**Consequences.**
- Every clock-dependent query is deterministic and unit-testable with a fixed `now`, and every call within one cycle agrees on what "now" means.
- `DoorDeps.now` and the digest's `now` parameter are the one seam to fake in a test; there is no second, hidden clock inside the SQL to also account for.
- Production behaviour is unchanged — `deps.now ?? (() => new Date())` still reads the real clock when no override is supplied.
