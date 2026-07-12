# Spike 0001 — Moodle session authentication

**Date:** 2026-07-13

**Status:** Complete; probe retired after the production scheduler took over

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

## Retired deployment

- Worker: `unicorn-moodle-auth-spike` (deleted 2026-07-13)
- Former URL: `https://unicorn-moodle-auth-spike.bunizao.workers.dev`
- Former health check: `GET /health`
- Former authenticated manual probe: `POST /probe`
- Intended cron during validation: every five minutes

The Worker included a `scheduled` handler, but its cron trigger was not registered. The Cloudflare account had reached its five-trigger limit:

| Worker | Schedule |
| --- | --- |
| `notify-scheduler` | `*/15 * * * *` |
| `sink` | `0 0 * * *` |
| `site` | `*/15 * * * *` |
| `site-api` | `0 * * * *` |
| `site-api` | `*/15 * * * *` |

The spike deployment intentionally omitted the trigger, so validation used the temporary Codex automation instead.

## Observation

The local Codex automation `Watch Moodle session` called the deployed Worker every six hours during the experiment. Its probe token lived in the macOS login Keychain and was also configured as a Worker secret; it was not stored in this repository.

The automation did not refresh credentials, run an Okta login, or repair a failed session. Each successful probe therefore extended the session only through the same Worker-originated `/my/` request the production scheduler uses. The first monitored probe succeeded on 2026-07-13.

## Closeout

The production `unicorn` Worker now performs the same keep-alive path through its hourly Durable Object alarm. The standalone spike Worker and its Codex automation were deleted after production verification so they could not retain copied source credentials or generate stale alerts. Session lifetime remains an operational observation on the production scheduler, not a separate deployment.
