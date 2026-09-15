# Gmail source setup (ADR-0033)

Gmail is ingested through Google's own remote Gmail MCP server, not a bespoke API
client. unicorn is the MCP **client**: it authenticates with your own Google Cloud
OAuth client, calls `search_threads` on the hourly cycle, and maps the result into
the generic Item model like any other declarative plugin.

**Status: unverified against a real account.** Everything below is built and unit
tested against a fake MCP server and a fake Google token endpoint (see
`tests/declarative-plugin.test.ts` and `tests/oauth.test.ts`), because CI has no
Google account to exercise. The mapping in `src/plugins/presets/gmail.json` follows
the response shape documented at
https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/search_threads,
which is itself marked "Developer Preview" by Google — treat the first real `/sync`
after deploy as the actual acceptance test, not this document.

## 1. Create a Google Cloud project (or reuse one)

https://console.cloud.google.com/projectcreate

## 2. Enable two APIs

Gmail MCP is a separate API from the classic Gmail API — you need both:

```
gcloud services enable gmail.googleapis.com gmailmcp.googleapis.com --project=<PROJECT_ID>
```

or via the console: **APIs & Services → Library**, enable "Gmail API" and "Gmail MCP
API".

## 3. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen**:

- User type: **External**, publishing status: **Testing** (this is what lets a
  self-deploy skip Google's verification review — ADR-0033's whole premise).
- Add yourself as a **test user** (your own Google/Workspace address — Monash
  student mail is Google Workspace, so your `@student.monash.edu` address works
  here).
- Under **Data access**, add the scope `https://www.googleapis.com/auth/gmail.readonly`.
  (Google's Gmail MCP configuration guide also lists `gmail.compose` for MCP clients
  that draft mail; unicorn only reads, so `gmail.readonly` is enough — omit
  `gmail.compose` unless you extend the preset to write.)

## 4. Create an OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**.
- Authorized redirect URI: `https://<your-worker>.workers.dev/settings/oauth/callback`
  (exactly this path — `handleCallback` in `src/oauth.ts` rejects anything else
  implicitly, since it re-derives this same URL to complete the exchange).

Copy the **client ID** and **client secret**.

## 5. Store the client credentials as Worker secrets

```
wrangler secret put PLUGIN_SECRET_GOOGLE_CLIENT_ID
wrangler secret put PLUGIN_SECRET_GOOGLE_CLIENT_SECRET
```

(`scripts/setup.mjs` offers to do this for you during initial setup.) These live in
the `PLUGIN_SECRET_*` namespace like every other declarative-plugin credential
(ADR-0033/ADR-0017's quarantine) — never in D1, never logged.

## 6. Connect

Open `/settings` (HTTP Basic, username `unicorn`, password your `ADMIN_TOKEN`). Once
both secrets above are set, a **Gmail** card appears with a **Connect Gmail** button:

1. Click it → redirected to Google's consent screen.
2. Approve access with your test-user account.
3. Redirected back to `/settings/oauth/callback`, which exchanges the code, stores
   the refresh token in D1 (`oauth_tokens`, table added by
   `migrations/0011_oauth_tokens.sql`), and installs the `gmail` preset manifest
   (`src/plugins/presets/gmail.json`) into `plugin_manifests` — one click really is
   the whole setup.
4. The Gmail card now reads "Connected".

If you ever see `oauth_missing_refresh_token`, Google didn't hand back a new refresh
token (it only does on first consent or when `prompt=consent` forces re-consent,
which unicorn always sends — if this still happens, revoke unicorn's access at
https://myaccount.google.com/permissions and reconnect).

## 7. Verify

```
curl -X POST https://<your-worker>.workers.dev/sync -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Look for a `gmail` entry in the response's `results` (not `errors`). Then, through
the admin MCP:

```
list_items source=gmail
```

should return recent threads as generic Items with `title` = subject, `body` =
message snippet, a `course-mention` facet when a unit code (e.g. `FIT2004`) appears
in the subject or body, and an `author` facet with the sender.

## Known gaps / things to double check on first real sync

- **Argument name and view.** The preset calls `search_threads` with
  `{"query": "newer_than:14d", "pageSize": 50}` — the parameter names in Google's
  published input schema. The default `view` (THREAD_VIEW_MINIMAL) is assumed to
  include `subject`, `sender`, `date` and `snippet` per message; `body` maps to
  `snippet` because `plaintextBody` may be absent in the minimal view. If the first
  sync yields items without titles, set `"view"` in `transport.arguments` to the
  full variant via `install_plugin` on the admin MCP and re-sync.
- **Message ordering.** The preset reads `messages.0.subject` / `.date` /
  `.plaintextBody` / `.sender` — i.e. the *first* message in each thread. If Gmail
  MCP returns messages newest-first instead of oldest-first, the mapped title/body
  will be the latest reply rather than the thread's original subject. Adjust the
  index (or, if the shape turns out to expose a thread-level `subject`/`snippet`
  directly, map from there instead) and reinstall the manifest.
- **No `url` field.** The documented response has no web link for a thread, so the
  preset omits `mapping.url`. If Gmail MCP's real payload includes one, add
  `"url": { "path": "..." }` to the manifest.
- **Rate limits / pagination.** `search_threads` supports `pageSize` (max 50) and
  `pageToken`; the preset takes the single default page. If your inbox regularly has
  more than that in a 14-day window, widen `pageSize` in `transport.arguments`
  (pagination itself is out of scope for v1 — the declarative plugin calls the tool
  once per cycle).

## Reference

- ADR-0033 in `docs/ADR.md`.
- Manifest format: `src/plugins/declarative/plugin.ts` (`PluginManifest`,
  `ManifestTransport`).
- OAuth implementation: `src/oauth.ts`.
- Preset: `src/plugins/presets/gmail.json`.
- Course-mention extractor: `src/plugins/course-mention.ts`.
