# Hosting unicorn for others

unicorn runs in two modes from the same code:

| | Self-deploy (Cloudflare) | Hosted (your server) |
| --- | --- | --- |
| Who it's for | one student, their own account | many students, one instance |
| Setup for a student | clone, `npm run setup`, wrangler | sign up, paste tokens, click Connect |
| Data | their D1 | one SQLite file per student |
| Decision record | ADR-0001 | ADR-0046 |

This page covers the hosted mode: a Node server you run on a machine you control.

## Requirements

- Node 22.19+ (for `node:sqlite` with FTS5), or Docker.
- A domain with HTTPS. OAuth connectors (Claude, ChatGPT) require it, and the session and consent
  cookies are `__Host-`/`Secure`.

## Run it with Docker and Caddy

```bash
git clone https://github.com/TuuHub/unicorn && cd unicorn/deploy
cat > .env <<EOT
UNICORN_DOMAIN=unicorn.example.com
UNICORN_SECRET=$(openssl rand -base64 48)
UNICORN_OPERATOR=Your Name
UNICORN_SIGNUP=open            # or invite (with UNICORN_SIGNUP_CODE) or closed
EOT
docker compose up -d
```

Caddy gets a certificate for `UNICORN_DOMAIN` automatically. Data lives in the `unicorn-data`
volume: `control.sqlite` plus `tenants/<id>.sqlite`. **Back up that volume and `.env` together.**

## Run it without Docker

```bash
npm ci
npm run server:build
UNICORN_PUBLIC_URL=https://unicorn.example.com \
UNICORN_SECRET="$(openssl rand -base64 48)" \
UNICORN_DATA_DIR=/var/lib/unicorn \
UNICORN_TRUST_PROXY=1 \
node dist/server.mjs
```

Put any reverse proxy with TLS in front of port 8787. For local development, run
`npm run server:dev` and open http://localhost:8787.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `UNICORN_PUBLIC_URL` | required | The URL students and MCP clients use. Every link and the OAuth issuer derive from it. |
| `UNICORN_SECRET` | required | At least 32 characters. Derives each student's encryption key and personal token. |
| `UNICORN_DATA_DIR` | `./data` | |
| `UNICORN_MIGRATIONS` | `./migrations` | |
| `PORT` | `8787` | |
| `UNICORN_OPERATOR` | "the operator of this instance" | Shown on the landing page. |
| `UNICORN_SIGNUP` | `open` | `open`, `invite`, or `closed`. |
| `UNICORN_SIGNUP_CODE` | | The invite code, when `invite`. |
| `UNICORN_MAX_ACCOUNTS` | | Closes sign-up at this many accounts. |
| `UNICORN_TRUST_PROXY` | | `1` behind a proxy, so login rate limits use `X-Forwarded-For`. |
| `MOODLE_BASE_URL`, `CANVAS_BASE_URL` | Monash Moodle | Defaults for every student; each can override them under Sources. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | | Enables Connect Gmail. Add `<UNICORN_PUBLIC_URL>/settings/oauth/callback` as a redirect URI. |

## What a student sees

1. **`/`**: what unicorn does, how it works, and who runs this instance.
2. **Sign up**: email and password. Their database is created on the spot.
3. **Sources**: paste an Ed token and a Canvas token. For Moodle, either paste the `MoodleSession`
   cookie or run `npm run moodle:push -- --hosted https://unicorn.example.com --token <token>`
   after `okta login`.
4. **Connect**: paste `https://unicorn.example.com/mcp` into Claude, ChatGPT or Claude Code. A
   pop-up asks them to sign in and approve. That is the whole connection.
5. **Overview, Activity, Memory**: what is due, every call their agents made, and everything
   their agents remember about them, which they can edit.

## Operating notes

- **Never rotate `UNICORN_SECRET` casually.** Every student's stored source tokens become
  undecryptable, and every personal access token changes (ADR-0039, ADR-0046). Students would
  have to re-enter their tokens.
- **Deleting an account** (Account → Delete) removes the student's database file, their sessions
  and their OAuth grants.
- **Logs** are one JSON line per event. Cycle logs carry counts, never titles or content.
- **Scale.** Each tenant's cycle is a few HTTP calls per source per hour. One small VM handles
  hundreds of students. SQLite files are opened lazily and kept open.
- **Not on the hosted server:** the admin MCP (`/mcp/admin`) and CIMD client ids (clients use
  dynamic registration).
