# Spike 0001 — Moodle session authentication

**Date:** 2026-07-13

**Status:** Worker path validated; scheduled execution blocked by account cron capacity

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

## Remaining validation

Free one account cron slot or raise the account limit, register the spike schedule, and observe session validity over multiple scheduled runs. This is the only remaining part of ADR-0003's keep-alive assumption.
