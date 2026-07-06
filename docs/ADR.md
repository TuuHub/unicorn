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

**Status:** Accepted

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

**Status:** Accepted

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
