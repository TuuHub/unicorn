# Tier-1 declarative manifest format (ARCHITECTURE §5, ADR-0017/0038)

A Tier-1 plugin is one JSON document: an HTTPS fetch (or a remote MCP tool call) plus
a field mapping from the source's records into the generic `Item` model. A generic
engine (`src/plugins/declarative/plugin.ts`) runs every manifest; nothing here is
code an agent needs to write by hand — an agent reads a sample API response and
generates this JSON.

Manifests are stored in D1 (`D1ManifestStore`, `src/plugins/declarative/store.ts`)
and validated by `parsePluginManifest` on every read and write, so an invalid
manifest can never reach `pull()`.

## Top-level shape

Every manifest has:

```json
{ "version": 1, "id": "example-issues", "name": "Example issues", "mapping": { ... } }
```

- `id` — lowercase, `[a-z0-9-]`, becomes `Item.source`.
- `name` — display name.
- `mapping` — see below.

Then exactly one of:

- **HTTP/RSS** (`format`, `url`, optional `auth`, optional `pagination`/`fanOut`) — one
  HTTPS fetch. `format` is `"json"` or `"rss"`.
- **MCP** (`transport: { type: "mcp", url, tool, arguments?, auth? }`) — one remote
  MCP tool call. `auth` is `{ type: "bearer", binding }` or `{ type: "oauth", provider: "google" }`.
  Pagination and fan-out are **not** supported here — the MCP server owns paging its
  own tool, so there's nothing for the manifest to drive.

Both forms accept `itemsPath`: a dot path into the response body that resolves to
the array of records to map (e.g. `"data.issues"`, or `"messages.0.subject"` — numeric
segments index into arrays). Omit it when the response body is already the array.

## Auth

`auth` (HTTP) is one of:

```json
{ "type": "bearer", "binding": "PLUGIN_SECRET_X" }
{ "type": "header", "name": "X-Api-Key", "binding": "PLUGIN_SECRET_X" }
{ "type": "query", "name": "key", "binding": "PLUGIN_SECRET_X" }
```

`binding` must name a `PLUGIN_SECRET_*` Worker secret — a manifest can never read any
other secret (the namespace is the allowlist; see `pluginBindings` in plugin.ts).

## Mapping

```json
"mapping": {
  "id": { "path": "id" },
  "kind": { "value": "issue" },
  "title": { "path": "summary" },
  "timestamp": { "path": "created_at" },
  "url": { "path": "html_url" },
  "body": { "path": "description" },
  "facets": [ ... ]
}
```

Every field is a `ValueSpec`: either `{ "path": "<dot.path>" }` (read from the
record) or `{ "value": <json> }` (a literal). `id`, `kind`, `title`, `timestamp` are
required; `url` and `body` are optional.

`facets` is a list of either:

- A **static facet** — `{ "type": "...", "fields": { "<name>": ValueSpec }, "capabilities": [...] }`.
  Each capability is `{ "name", "primitive": "temporal"|"state"|"relation"|"actor"|"scalar", "field" }`.
- A **derived facet** — currently only `{ "derive": "course-mention", "from": ["title", "body"] }`,
  which the runtime computes itself (unit-code regex) instead of reading a field.

There is no expression language anywhere in a manifest — every value comes from a
literal or a dot path into a record (or, with fan-out, into the parent record — see
below). This is deliberate: it keeps a manifest safe for an agent to generate and a
human to read.

## Pagination

`pagination` (HTTP, `format: "json"` only) follows extra pages before the mapping
runs; every page's `itemsPath`-resolved records are concatenated first. One of:

```json
{ "type": "link-header" }
```
Follows the RFC 8288 `Link: <url>; rel="next"` response header (Canvas, GitHub).

```json
{ "type": "cursor", "cursorPath": "nextCursor", "param": "cursor" }
```
Reads the next cursor from the response body at `cursorPath` and sets it as `param`
on the next request. Stops when the cursor is missing, `null`, or `""`.

```json
{ "type": "page", "param": "page", "start": 1 }
```
Increments `param` by 1 each page, starting at `start`. Stops on an empty page.

All three accept `"maxPages"` (default 5, hard cap 10, enforced by the schema).

**Cross-origin guard:** a `link-header` next URL is server-supplied, untrusted
input. If it points at a different origin than the request that returned it, the
pull fails with an error instead of following it — otherwise the manifest's auth
header would be sent to a host the manifest never declared. `cursor` and `page`
pagination only ever add a query param to the manifest's own URL, so they can't
redirect anywhere else.

## Fan-out

`fanOut` (HTTP, `format: "json"` only) fetches a parent list once, then runs the
main request once per parent element:

```json
"fanOut": {
  "from": { "url": "https://api.example.com/courses", "itemsPath": "courses", "pagination": { "type": "link-header" } },
  "as": "course",
  "max": 10
}
```

- `from` — a parent-list fetch: `url` (required), optional `itemsPath`, optional
  `pagination` (any of the three shapes above).
- `as` — the placeholder variable name, referenced in the main `url` as
  `{{course.<path>}}` (URL-encoded on substitution). The manifest's own `url` must
  use this exact name — an unknown or mistyped var name fails validation.
- `max` — how many parents to iterate, 1 to 20.

The main `url` and `pagination`/`itemsPath` behave exactly as in the non-fan-out
case, just run once per parent. A mapping `ValueSpec` can read the *current parent
record* instead of the child record with a `$parent.` path prefix:

```json
"body": { "path": "$parent.code" }
```

`$parent.` paths are rejected by the schema unless the manifest has a `fanOut`.

**Subrequest budget:** a single `pull()` call is capped at 25 subrequests total
(parent-list pages + every per-parent main-request page combined) — Cloudflare
Workers' free plan allows 50 per invocation, shared across every plugin the sync
cycle runs. Exceeding it fails the pull with a clear error rather than silently
truncating a source's data; the sync cycle already turns that into a per-plugin
error like any other pull failure.

## Worked example 1 — a paginated REST list

A GitHub-shaped issue tracker, one page of up to 100 issues per request, following
`Link: rel="next"`:

```json
{
  "version": 1,
  "id": "example-issues",
  "name": "Example issues",
  "format": "json",
  "url": "https://api.example.com/issues?per_page=100",
  "auth": { "type": "bearer", "binding": "PLUGIN_SECRET_EXAMPLE" },
  "pagination": { "type": "link-header", "maxPages": 5 },
  "mapping": {
    "id": { "path": "id" },
    "kind": { "value": "issue" },
    "title": { "path": "title" },
    "timestamp": { "path": "updated_at" },
    "url": { "path": "html_url" },
    "body": { "path": "body" }
  }
}
```

## Worked example 2 — fan-out over courses

A Canvas-shaped API: list courses, then list each course's assignments, tagging
each assignment with its course code:

```json
{
  "version": 1,
  "id": "example-assignments",
  "name": "Example course assignments",
  "format": "json",
  "url": "https://example.instructure.com/api/v1/courses/{{course.id}}/assignments?per_page=50",
  "auth": { "type": "bearer", "binding": "PLUGIN_SECRET_EXAMPLE_LMS" },
  "pagination": { "type": "link-header" },
  "fanOut": {
    "from": {
      "url": "https://example.instructure.com/api/v1/courses?per_page=50",
      "pagination": { "type": "link-header" }
    },
    "as": "course",
    "max": 15
  },
  "mapping": {
    "id": { "path": "id" },
    "kind": { "value": "assignment" },
    "title": { "path": "name" },
    "timestamp": { "path": "due_at" },
    "url": { "path": "html_url" },
    "body": { "path": "$parent.course_code" }
  }
}
```
