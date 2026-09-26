# Deploying unicorn

Two audiences, one path. Whether you're a human at a terminal or a coding agent told
"deploy this," the deploy is a single command:

```bash
npm run setup
```

That runs `scripts/setup.mjs`, a linear installer (ADR-0027) that:

1. checks Node ≥ 22.19 and installs dependencies,
2. runs `wrangler login` (a browser window opens for OAuth — pass it through),
3. creates the `unicorn` D1 database and writes the returned `database_id` back into `wrangler.jsonc`,
4. applies migrations,
5. sets your timezone (auto-detected, or `--timezone <iana-zone>`),
6. generates random `ADMIN_TOKEN` and `MCP_TOKEN` secrets and stores them via `wrangler secret put`,
7. asks which sources you use — Ed / Moodle / Canvas / Gmail (ADR-0038) — and configures
   only those: a pasted token/URL becomes a `wrangler secret put`, Moodle instead runs
   `npm run moodle:push`, and Gmail is finished from `/settings` after deploy (it's a
   Google OAuth flow, not a pasted token). Skip a source here and add it later from
   `/settings` any time — no redeploy needed,
8. deploys the Worker,
9. starts the hourly scheduler with `POST /schedule`, and prints the connector command
   (Claude Code / claude.ai / ChatGPT) and the Claude Code plugin install commands.

Secrets only ever enter through Wrangler; the Worker never rewrites its own secrets (ADR-0022).

## For coding agents

Run `npm run setup` and let its child processes own the interactive prompts — do not try
to script around the browser OAuth step. For a fully non-interactive run, pass `--yes`
plus whichever of `--sources <list>`, `--worker-url <url>`, `--timezone <iana-zone>` you
already know (or the equivalent `SETUP_YES`/`SETUP_SOURCES`/`SETUP_WORKER_URL`/
`SETUP_TIMEZONE` env vars) — e.g. `node scripts/setup.mjs --sources ed,canvas --yes`. A
source's secret still comes from its usual env var if you set one first (`ED_API_TOKEN`,
`CANVAS_BASE_URL` + `PLUGIN_SECRET_CANVAS_TOKEN`, `PLUGIN_SECRET_GOOGLE_CLIENT_ID` +
`PLUGIN_SECRET_GOOGLE_CLIENT_SECRET`); with `--yes` and no such env var, that source is
skipped with a note to paste it into `/settings` instead of the script silently prompting.

## Upgrading an existing deployment

`npm run setup` is for a **first install**. If the Worker and its D1 already exist (you're
pulling new code), upgrade instead — apply any new migrations, then redeploy, in that order:

```bash
npm run upgrade   # = wrangler d1 migrations apply unicorn --remote && wrangler deploy
```

Migrating before deploying matters: the new code's scheduler cycle reads tables that a
new migration adds, so deploying first would make every hourly tick fail until the
migration lands. The Durable Object scheduler and its alarm survive a code redeploy
untouched. (`npm run setup` also handles the upgrade case now — it reuses an existing D1
rather than aborting — but `npm run upgrade` is the minimal, non-interactive path.)

## Declarative plugin secrets

Tier-1 declarative plugins (ADR-0017) can authenticate against their source, but a
manifest is attacker-reachable (an AI generates it, or your MCP client installs one).
So a manifest's `auth.binding` may only name a secret in the dedicated `PLUGIN_SECRET_*`
namespace — never `ADMIN_TOKEN`, `MOODLE_SESSION`, or any other Worker secret. Provision
a plugin's credential like:

```bash
npx wrangler secret put PLUGIN_SECRET_MYFEED
```

and reference it as `{ "auth": { "type": "bearer", "binding": "PLUGIN_SECRET_MYFEED" } }`.

## The daily digest and timezone

There is no server-side model call anywhere in the Worker (ADR-0034). The one scheduled
routine is a zero-LLM daily digest, written once local time reaches 07:00 in the
`timezone` setting (an IANA name, default `Australia/Melbourne`) — set it from
`/settings` if you're not in that zone.

## MCP endpoints

Two separate MCP servers, two separate tokens (ADR-0030):

- `/mcp` — the **door**, three tools (`get_briefs`, `ack_briefs`, `remember`) for
  your own client agent. Bearer `MCP_TOKEN`. Add it with:

  ```bash
  claude mcp add --transport http unicorn https://<worker>/mcp --header "Authorization: Bearer <MCP_TOKEN>"
  ```

- `/mcp/admin` — the operator tools (item/plugin/sync inspection and the
  `list_corrections` memory read). Bearer `ADMIN_TOKEN`. This is what you (or a coding
  agent acting as operator) use to inspect unicorn itself — a client agent should never
  be pointed at this endpoint.

The daily digest writes its output as a **brief** (ADR-0031), pulled through
`get_briefs` and acknowledged with `ack_briefs` — there is no push notification for it.
