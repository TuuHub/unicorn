# Deploying unicorn

Two audiences, one path. Whether you're a human at a terminal or a coding agent told
"deploy this," the deploy is a single command:

```bash
npm run setup
```

That runs `scripts/setup.mjs`, a linear installer (ADR-0027) that:

1. checks Node ≥ 20 and installs dependencies,
2. runs `wrangler login` (a browser window opens for OAuth — pass it through),
3. creates the `unicorn` D1 database and writes the returned `database_id` back into `wrangler.jsonc`,
4. applies migrations,
5. generates random `ADMIN_TOKEN` and `MCP_TOKEN` secrets and stores them via `wrangler secret put`,
6. optionally accepts an Ed API token and pushes a Moodle session (`npm run moodle:push`),
7. deploys the Worker,
8. starts the hourly scheduler with `POST /schedule`.

Secrets only ever enter through Wrangler; the Worker never rewrites its own secrets (ADR-0022).

## For coding agents

Run `npm run setup` and let its child processes own the interactive prompts — do not try
to script around the browser OAuth step. When the script asks for the Ed token or Moodle
push, answer from what the user gave you; if you don't have those, decline (both are
optional and can be added later with `wrangler secret put`).

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

## Notifications (optional)

The notifier fans out to every channel whose secrets are present (ADR-0010, ADR-0026):

```bash
npx wrangler secret put NOTIFIER_URL        # Discord webhook
npx wrangler secret put TELEGRAM_BOT_TOKEN   # Telegram bot
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put RESEND_API_KEY       # Resend email (needs a verified sender domain)
npx wrangler secret put EMAIL_FROM           # e.g. unicorn@your-domain.com
npx wrangler secret put EMAIL_TO
```

All outbound messages go through a durable outbox with idempotency keys and bounded
retry (ADR-0025), so a retried cycle never double-sends.

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

## Agent jobs (optional)

Both `daily-digest` and `triage` are disabled by default. Configure them through the MCP
tools `configure_agent_job`, `list_agent_jobs`, and `list_agent_job_runs`, after setting
`AI_API_KEY` and (if not OpenAI) `AI_BASE_URL`. Triage watches facet events, keeps
deterministic reflexes (a deadline within 7 days is always important), and speaks only
when something matters (ADR-0023). It reads your remembered judgments from the capped
notes memory (ADR-0024), which your own MCP client edits through `get_memory` /
`update_memory`.
