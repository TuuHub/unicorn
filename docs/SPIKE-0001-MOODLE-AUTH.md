# Spike 0001 — Moodle session authentication

**Date:** 2026-07-13

**Status:** Worker path validated; keep-alive observation active through Codex automation

## Question

Can a Cloudflare Worker use a locally acquired `MoodleSession` cookie to load the authenticated dashboard, derive a fresh `sesskey`, and call Moodle's timeline AJAX method without browser automation?

## Result

Yes.

The local CLI and the deployed Worker both completed this path:

1. Send the `MoodleSession` cookie to `GET /my/`.
2. Extract `sesskey` from the returned page context.
3. Call `core_calendar_get_action_events_by_timesort` through `/lib/ajax/service.php`.
4. Receive a valid timeline response.

The deployed probe returned `authenticated: true`. The timeline contained no current items, which is a valid empty result.

The session and probe token are Cloudflare Worker secrets. They are never stored in the repository, returned by the Worker, or written to logs.

## Deployment

- Worker: `unicorn-moodle-auth-spike`
- URL: `https://unicorn-moodle-auth-spike.bunizao.workers.dev`
- Health check: `GET /health`
- Authenticated manual probe: `POST /probe`
- Intended cron during validation: every five minutes

The Worker includes a `scheduled` handler, but its cron trigger is not registered. The Cloudflare account has reached its five-trigger limit:

| Worker | Schedule |
| --- | --- |
| `notify-scheduler` | `*/15 * * * *` |
| `sink` | `0 0 * * *` |
| `site` | `*/15 * * * *` |
| `site-api` | `0 * * * *` |
| `site-api` | `*/15 * * * *` |

Default deployment intentionally omits the trigger until capacity is available, so `npm run deploy` remains usable.

## Observation

The local Codex automation `Watch Moodle session` calls the deployed Worker every six hours. Its probe token lives in the macOS login Keychain and is also configured as a Worker secret; it is not stored in this repository.

The automation does not refresh credentials, run an Okta login, or repair a failed session. Each successful probe therefore extends the session only through the same Worker-originated `/my/` request the eventual Cloudflare cron will use. The first monitored probe succeeded on 2026-07-13.

## Remaining validation

Continue observing until the session expires or survives long enough to accept the keep-alive assumption. A free account cron slot is still required to validate Cloudflare's trigger delivery, but it no longer blocks the session-lifetime experiment itself.
