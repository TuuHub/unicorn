# Connecting a client to unicorn

unicorn is an OAuth 2.1 authorization server for its own door (`POST /mcp`, ADR-0035). Any MCP
client that speaks OAuth with dynamic client registration (DCR) and PKCE can add it as a remote
connector — no manual client setup on your end. The consent screen is gated by the same
`ADMIN_TOKEN` you already use for `/settings`.

The static `MCP_TOKEN` bearer still works everywhere, for local development or any client that
doesn't do OAuth: `Authorization: Bearer <MCP_TOKEN>` against `<your-worker-url>/mcp`.

## claude.ai (web and desktop)

1. Settings → Connectors (or Customize → Connectors, depending on rollout) → **Add custom
   connector**.
2. Enter `https://<your-worker-url>/mcp`.
3. Claude registers itself via DCR and redirects you to `/authorize`. Sign in with the
   `unicorn` / `ADMIN_TOKEN` Basic-auth prompt your browser shows, then **Approve**.
4. The connector now appears under Search & tools in any chat.

On a Team/Enterprise plan, an organization owner adds the connector once under Organization
settings → Connectors; members then click **Connect** under their own Customize → Connectors and
go through the same `/authorize` approval individually — each person gets their own OAuth grant,
listed separately under unicorn's **Connected apps** in `/settings`.

## Claude mobile and Cowork

Both read the same account-level connector list as claude.ai web/desktop — remote MCP connectors
are brokered through your Claude account, not stored on-device. Once you've approved unicorn from
web or desktop, it's already available in the mobile app and in Cowork; no separate registration
step. Cowork's scheduled tasks reach unicorn as this same OAuth-authenticated connector, which is
how a scheduled `run_playbook` (weekly plan, forum brief, …) gets in.

## Claude Code (and Claude Code routines)

```
claude mcp add --transport http unicorn https://<your-worker-url>/mcp
```

Claude Code registers a client via DCR on first use; run `/mcp` inside a session (or
`claude mcp get unicorn` for the auth URL) to open the browser and complete `/authorize`. A Claude
Code routine reuses that same authenticated connection.

For a headless box you don't want to run a browser flow on, skip OAuth and use the static token
instead:

```
claude mcp add --transport http unicorn https://<your-worker-url>/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

## ChatGPT

Requires a paid plan (Plus and above) with **Developer mode** turned on: Settings → Apps &
Connectors → Advanced settings → Developer mode. Then Settings → Connectors → **Create** →
enter `https://<your-worker-url>/mcp` as a custom connector.

ChatGPT's OAuth requirements are strict — plain bearer tokens are not accepted at all here, only
OAuth 2.1 with dynamic client registration — which is exactly what `/authorize` + `/register`
already provide, so no extra work is needed on unicorn's side. unicorn's authorization server also
accepts Client ID Metadata Documents (CIMD) as an alternative to DCR (ADR-0043) — relevant to a
client that registers itself that way rather than via `/register`; ChatGPT and Claude both use DCR
today, so this mostly matters for future or custom MCP clients.

Two things worth knowing before you rely on this:
- ChatGPT's MCP client only calls **tools**, not MCP *prompts*. The door's playbooks
  (`weekly-plan`, `forum-brief`, …) are served as prompts for clients that support that MCP
  primitive (Claude Code, claude.ai) and also as the `run_playbook` tool — from ChatGPT, always
  call `run_playbook` directly rather than looking for the playbook in a prompt picker.
- Tool calls that write (anything beyond reading memory) may show a per-call approval prompt in
  ChatGPT by default; that's ChatGPT's own safety default, not something unicorn's scope model
  requires (unicorn's one scope, `memory`, already limits what a stolen token could do — see
  ADR-0035).

## What "Approve" actually grants

Every client above ends up with one OAuth grant, scoped to `memory`: *"Read your unicorn memory
and update its own state — never writes to Ed, Moodle, Canvas or Gmail."* Access tokens last an
hour and refresh silently for 30 days. Revoke any client any time from **Connected apps** in
`/settings` — the client has to redo `/authorize` to reconnect.
