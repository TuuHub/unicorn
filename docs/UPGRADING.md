# Upgrading from the resident-agent deploy

This is for a **production Worker already running the pre-memory-layer agent** —
migration `0011` (Gmail/OAuth-tokens, ADR-0033), the Pi resident agent, the four-tool
door, Telegram. Not for a first install; that's [SETUP.md](../SETUP.md).

If you don't know which migration your deploy is on:

```bash
npx wrangler d1 migrations list unicorn --remote
```

Everything below assumes you're moving from `0011` to the current `HEAD` (through
`0013`, plus `0014` once wave2/sources merges).

## 1. Back up first

D1 has no point-in-time restore on the free tier. Export before touching anything:

```bash
npx wrangler d1 export unicorn --remote --output backup.sql
```

(`--remote` and `--output` are real flags on the installed `wrangler` — verified with
`npx wrangler d1 export --help`.) Keep `backup.sql` until you've run the post-upgrade
checks below and are satisfied.

## 2. Migrate, then deploy — in that order

```bash
npm run upgrade
```

That's `package.json`'s `upgrade` script:

```
wrangler d1 migrations apply unicorn --remote && wrangler deploy
```

Migrations run **before** the deploy, not after. The new code's hourly scheduler cycle
reads tables and columns the new migrations add — deploying first would make every
cycle fail until the migration lands. Don't run `wrangler deploy` on its own for this
upgrade; use `npm run upgrade` (or the two commands above, in that order) every time.

`wrangler d1 migrations apply` only runs migrations not already recorded as applied, so
running it against a deploy already on `0011` applies exactly `0012` and `0013` (and
`0014` once wave2/sources merges) — it does not re-run `0001`–`0011`.

## 3. What migration `0012` does to your data

This is the one migration in this upgrade that's destructive, and only to the tables
the removed agent owned:

**Dropped** (`DROP TABLE IF EXISTS`): `agent_turn_results`, `agent_messages`,
`agent_conversations`, `notifications_outbox`, `agent_job_runs`, `agent_jobs`. All
Pi conversation history, the notification outbox, and the agent-job ledger are gone
after this migration runs — there's no data in them worth keeping (ADR-0034), but they
are unrecoverable from D1 after this point without the `backup.sql` from step 1.

**Kept**: `agent_notes` — `remember`/the corrections domain still reads and writes it;
nothing in this upgrade touches it.

**Copied, not dropped and recreated**: your existing `events` (v1) rows are copied into
the new `changes` table (events v2, ADR-0036) with a `LEFT JOIN` back to `items` to
backfill `kind`/`title`/`url` for each row, keeping their original v1 type names
(`item.created`, `item.updated`, `capability.changed`) rather than being retyped. Only
after the copy does the migration `DROP TABLE events`. `changes_since`'s cursor starts
at the current max `seq`, so nothing already delivered to a client re-appears as new.

Also in `0012`: `course`/`bucket`/`topic`/`labeled_by` columns are added to `items`; an
FTS5 virtual table (`items_fts`) is created and backfilled over existing `title`/`body`;
and `briefs` is rebuilt (same rows, same unread index) to drop the old fixed-`kind`
`CHECK` constraint so routines can write their own brief kinds through `write_brief`.

## 4. What `0013` (and `0014`) do — nothing destructive

`0013_user_tools.sql` is purely additive: the `user_tools` table and the five read-only
views (`v_items`, `v_upcoming`, `v_changes`, `v_courses`, `v_buckets`) that `describe_schema`
and every user-defined tool read from. No existing table is altered or dropped.

`0014_source_credentials.sql` (wave2/sources, merges before release) is also purely
additive: one new table, `source_credentials`, for encrypted `/settings`-pasted
credentials (see the ADR-0039 amendment in [ADR.md](ADR.md)). If an existing deploy
already has `ED_API_TOKEN` / `MOODLE_SESSION` / `PLUGIN_SECRET_CANVAS_TOKEN` set as
Worker Secrets, this migration changes nothing about how those sources authenticate —
a Worker Secret always wins over anything later pasted into `/settings`.

## 5. Bindings that provision or change themselves

- **`OAUTH_KV`** — the OAuth authorization server's storage (ADR-0035) has no
  `id` in `wrangler.jsonc`'s `kv_namespaces` entry. Wrangler ≥4.45 auto-provisions and
  binds a KV namespace with that binding name on `wrangler deploy` (and on `wrangler dev`
  locally), so `npm run upgrade` on an existing production deploy needs no manual
  `wrangler kv namespace create` step — the deploy in step 2 handles it.
- **Durable Object migration `v3` deletes the `AgentSession` class.** `wrangler.jsonc`'s
  `migrations` array now has three entries — `v1` (creates `Scheduler`), `v2` (created
  `AgentSession`), `v3` (`deleted_classes: ["AgentSession"]`) — and `wrangler deploy`
  applies whichever of these your deploy hasn't seen yet. Any Durable Object instances
  of `AgentSession` (the old per-conversation Pi routing) are deleted along with the
  class. This is separate from the D1 migrations in step 2 and needs no extra command;
  it's part of the same `wrangler deploy`.
- The `SCHEDULER` Durable Object and its alarm are untouched by any of this — the
  hourly cycle keeps ticking across the upgrade with no `POST /schedule` needed again,
  unless it was already stopped.

## 6. Secrets and bindings the new code never reads

Grep the removed agent's config for what it needed (verified against the pre-ADR-0034
commit, `09c78ae`):

```bash
git show 09c78ae:wrangler.jsonc   # the "ai" binding, AGENT_SESSIONS DO, AI_BASE_URL var
git show 09c78ae:SETUP.md         # the secret-put commands below
```

See what's actually set first with `npx wrangler secret list`. These Worker Secrets are no longer read by anything in `src/` and can be deleted:

```bash
npx wrangler secret delete AI_API_KEY           # BYOK model credential
npx wrangler secret delete TELEGRAM_BOT_TOKEN   # converse face, retired (ADR-0032/0034)
npx wrangler secret delete TELEGRAM_CHAT_ID
npx wrangler secret delete NOTIFIER_URL         # Discord webhook notifier, retired
npx wrangler secret delete RESEND_API_KEY       # email notifier, retired
npx wrangler secret delete EMAIL_FROM
npx wrangler secret delete EMAIL_TO
```

Two more items were never Worker Secrets, so there's nothing to delete with
`wrangler secret delete` — they're already gone once you deploy the current
`wrangler.jsonc`, which no longer declares either:

- The `ai` binding (`{ "binding": "AI" }`, the Workers AI binding the zero-secret
  default model used) — removed from `wrangler.jsonc`.
- The `AI_BASE_URL` var (a plain `vars` entry, not a secret, for the BYOK OpenAI-compatible
  base URL) — removed from `wrangler.jsonc`'s `vars`.

Keep: `ADMIN_TOKEN`, `MCP_TOKEN`, `ED_API_TOKEN`, `MOODLE_SESSION`, `MOODLE_BASE_URL`
(now a `vars` default, overridable per-source), `PLUGIN_SECRET_CANVAS_TOKEN`,
`CANVAS_BASE_URL`, `PLUGIN_SECRET_GOOGLE_CLIENT_ID`, `PLUGIN_SECRET_GOOGLE_CLIENT_SECRET`
— every one of these is still read by the current code.

## 7. Post-upgrade checks

```bash
curl https://<your-worker>/health
curl https://<your-worker>/.well-known/oauth-authorization-server
curl -X POST https://<your-worker>/sync -H "Authorization: Bearer <ADMIN_TOKEN>"
curl https://<your-worker>/schedule -H "Authorization: Bearer <ADMIN_TOKEN>"
```

- `/health` — `"status":"ready"`, `"database":true`, `"scheduler":"running"`. `"stopped"`
  means step 5's Durable Object survived the upgrade but the alarm itself isn't armed —
  `curl -X POST .../schedule -H "Authorization: Bearer <ADMIN_TOKEN>"` re-arms it.
- `/.well-known/oauth-authorization-server` — the RFC 8414 metadata document the
  OAuth authorization server (ADR-0035) serves; a 200 with `authorization_endpoint`,
  `token_endpoint`, and `registration_endpoint` confirms `OAUTH_KV` bound correctly.
- `/sync` (bearer `ADMIN_TOKEN`) — triggers one ingestion cycle immediately rather than
  waiting for the next alarm; 200 means every configured source pulled cleanly, 207
  means at least one source errored (check the response body's `sources[].lastError`).
- `/schedule` (bearer `ADMIN_TOKEN`, `GET`) — reports whether the hourly alarm is armed.
- The door's `status` tool — call it from any connected client, or
  `claude mcp add --transport http unicorn https://<worker>/mcp --header "Authorization: Bearer <MCP_TOKEN>"`
  then ask for it — to confirm each source's last sync time with no stale `lastError`
  from before the upgrade.

## Rollback

D1 migrations only go forward, and `backup.sql` can't be replayed over the migrated
database because its `CREATE TABLE`s collide with the tables that are already there.
So restore into a **new** database and point the old code at it:

```bash
npx wrangler d1 create unicorn-rollback                                  # prints a database_id
npx wrangler d1 execute unicorn-rollback --remote --file backup.sql
git checkout 09c78ae                                                     # or the commit you upgraded from
```

Edit that checkout's `wrangler.jsonc`: set `database_name` to `unicorn-rollback` and
`database_id` to the new id. Then append a Durable Object migration that re-creates the
class `v3` deleted — `{ "tag": "v4", "new_sqlite_classes": ["AgentSession"] }` — because
Cloudflare has already applied `v3`, and an old config whose last tag is `v2` is
rejected. Then run `npx wrangler deploy`.

`AgentSession` instance storage (old Pi conversation routing) doesn't come back; only D1
state does. The original `unicorn` database stays untouched, so you can roll forward
again later.
