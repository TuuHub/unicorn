import { renderConnectedApps } from "./oauth-server";
import { escapeHtml, htmlResponse, renderPage } from "./ui";
import {
  buildSourceStatuses,
  nonSecretPrefill,
  presetFor,
  SOURCE_PRESETS,
  testSource,
  type SourceCredentialStore,
  type SourceEnv,
  type SourceId,
  type SourceStatus,
} from "./sources";
import type { GrantSummary } from "@cloudflare/workers-oauth-provider";

export interface AppSettings {
  retentionDays: number;
  syncEnabled: boolean;
  // IANA timezone (e.g. "Australia/Melbourne"), used to gate the daily digest
  // to a user-local time of day (ADR-0034).
  timezone: string;
  // Gmail scope (ADR-0036): university domains and individually allowlisted
  // senders. Course-code mentions are always included and aren't stored here —
  // they're derived live from course-identity facets at cycle time.
  gmailDomains: string[];
  gmailAllowlist: string[];
}

export interface SettingsRepository {
  get(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
}

export interface LastCycleInfo {
  at: string | null;
  byPlugin: Record<string, { lastSyncAt: string | null; lastError: string | null }>;
}

export interface SettingsRuntime {
  adminToken: string;
  repository: SettingsRepository;
  sourceEnv: SourceEnv;
  credentials: SourceCredentialStore;
  lastCycle: LastCycleInfo;
  itemCounts: Record<string, number>;
  mcpToken: string;
  connections: {
    mcp: boolean;
    // Google OAuth client secrets configured (ADR-0033) — optional so callers that
    // predate the Gmail source (and existing tests) don't have to supply it.
    google?: boolean;
    // Whether a Gmail refresh token is on file (oauth_tokens), i.e. the one-time
    // browser dance at /settings/oauth/gmail/start has been completed.
    gmailConnected?: boolean;
  };
  // Live operational state, fetched by the route handler: whether the hourly
  // scheduler alarm is set.
  status: {
    schedulerRunning: boolean;
  };
  // POST /settings/sync-now: runs a forced cycle. Optional so tests that don't
  // exercise that route can omit it.
  runSync?: () => Promise<{ ok: boolean; error?: string }>;
  // OAuth connectors (ADR-0035): grants issued by /authorize, for the "Connected apps" card.
  // Optional so callers that predate connector support (and existing tests) don't need it.
  oauth?: { grants: GrantSummary[] };
}

const DEFAULT_TIMEZONE = "Australia/Melbourne";

const DEFAULT_SETTINGS: AppSettings = {
  retentionDays: 180,
  syncEnabled: true,
  timezone: DEFAULT_TIMEZONE,
  gmailDomains: [],
  gmailAllowlist: [],
};

export class D1SettingsRepository implements SettingsRepository {
  constructor(private readonly db: D1Database) {}

  async get(): Promise<AppSettings> {
    const row = await this.db.prepare("SELECT value_json FROM settings WHERE key = 'app'").first<{ value_json: string }>();
    if (!row) {
      return { ...DEFAULT_SETTINGS };
    }
    return parseSettings(JSON.parse(row.value_json));
  }

  async save(settings: AppSettings): Promise<void> {
    const value = parseSettings(settings);
    await this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('app', ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(value), new Date().toISOString())
      .run();
  }
}

export async function handleSettings(request: Request, runtime: SettingsRuntime): Promise<Response> {
  if (!isBasicAuthorized(request.headers.get("authorization"), runtime.adminToken)) {
    return new Response("Authentication required.", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="unicorn settings", charset="UTF-8"' },
    });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/settings") {
    const settings = await runtime.repository.get();
    return htmlResponse(await renderSettingsPage(settings, runtime, url, { saved: url.searchParams.has("saved") }));
  }

  if (request.method === "POST" && path === "/settings") {
    return handleMaintenancePost(request, runtime, url);
  }

  if (request.method === "POST" && path === "/settings/timezone") {
    return handleTimezonePost(request, runtime, url);
  }

  if (request.method === "POST" && path === "/settings/gmail-scope") {
    return handleGmailScopePost(request, runtime, url);
  }

  if (request.method === "POST" && path === "/settings/sync-now") {
    return handleSyncNowPost(request, runtime, url);
  }

  const sourceMatch = /^\/settings\/sources\/([a-z]+)(\/test|\/disconnect)?$/.exec(path);
  if (request.method === "POST" && sourceMatch) {
    const [, rawId, action] = sourceMatch;
    if (!isValidSourceId(rawId!)) {
      return json404();
    }
    const id = rawId as SourceId;
    if (action === "/test") {
      return handleSourceTestPost(request, runtime, url, id);
    }
    if (action === "/disconnect") {
      return handleSourceDisconnectPost(request, runtime, url, id);
    }
    return handleSourceSavePost(request, runtime, url, id);
  }

  return new Response("Method not allowed.", { status: 405, headers: { allow: "GET, POST" } });
}

function isValidSourceId(value: string): value is SourceId {
  return SOURCE_PRESETS.some((preset) => preset.id === value);
}

function json404(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

// --- CSRF ----------------------------------------------------------------------
//
// The page is single-user behind HTTP Basic auth, so a token bound to the admin
// credential itself is enough: HMAC(ADMIN_TOKEN, "settings-csrf"), verified in
// constant time. The Origin check (already the CSP's referrer-policy partner)
// stays as the second layer for every POST below.
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computeCsrfToken(adminToken: string): Promise<string> {
  return hmacSha256Hex(adminToken, "settings-csrf");
}

async function csrfOk(request: Request, form: FormData, runtime: SettingsRuntime, url: URL): Promise<boolean> {
  if (request.headers.get("origin") !== url.origin) {
    return false;
  }
  const expected = await computeCsrfToken(runtime.adminToken);
  return constantTimeEqual(String(form.get("csrf") ?? ""), expected);
}

// --- POST handlers ---------------------------------------------------------------

async function handleMaintenancePost(request: Request, runtime: SettingsRuntime, url: URL): Promise<Response> {
  const form = await request.formData();
  if (!(await csrfOk(request, form, runtime, url))) {
    return new Response("Invalid request.", { status: 403 });
  }
  const current = await runtime.repository.get();
  const retentionDays = Number(form.get("retentionDays"));
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 3650) {
    return htmlResponse(await renderSettingsPage(current, runtime, url, { error: "Retention must be between 7 and 3650 days." }), 400);
  }
  await runtime.repository.save({ ...current, retentionDays, syncEnabled: form.get("syncEnabled") === "on" });
  return redirectToSettings(url, "saved=1");
}

async function handleTimezonePost(request: Request, runtime: SettingsRuntime, url: URL): Promise<Response> {
  const form = await request.formData();
  if (!(await csrfOk(request, form, runtime, url))) {
    return new Response("Invalid request.", { status: 403 });
  }
  const current = await runtime.repository.get();
  const timezone = String(form.get("timezone") ?? "").trim();
  if (!isValidTimeZone(timezone)) {
    return htmlResponse(await renderSettingsPage(current, runtime, url, { error: "Timezone must be a valid IANA name, e.g. Australia/Melbourne." }), 400);
  }
  await runtime.repository.save({ ...current, timezone });
  return redirectToSettings(url, "saved=1");
}

async function handleGmailScopePost(request: Request, runtime: SettingsRuntime, url: URL): Promise<Response> {
  const form = await request.formData();
  if (!(await csrfOk(request, form, runtime, url))) {
    return new Response("Invalid request.", { status: 403 });
  }
  const current = await runtime.repository.get();
  const gmailDomains = parseLines(String(form.get("gmailDomains") ?? ""));
  const gmailAllowlist = parseLines(String(form.get("gmailAllowlist") ?? ""));
  await runtime.repository.save({ ...current, gmailDomains, gmailAllowlist });
  return redirectToSettings(url, "saved=1");
}

async function handleSyncNowPost(request: Request, runtime: SettingsRuntime, url: URL): Promise<Response> {
  const form = await request.formData();
  if (!(await csrfOk(request, form, runtime, url))) {
    return new Response("Invalid request.", { status: 403 });
  }
  const result = await runtime.runSync?.();
  return redirectToSettings(url, result?.ok === false ? `syncError=${encodeURIComponent(result.error ?? "sync_failed")}` : "synced=1");
}

async function handleSourceSavePost(request: Request, runtime: SettingsRuntime, url: URL, id: SourceId): Promise<Response> {
  const form = await request.formData();
  if (!(await csrfOk(request, form, runtime, url))) {
    return new Response("Invalid request.", { status: 403 });
  }
  const preset = presetFor(id);
  const lookup = await runtime.credentials.get(id);
  const base = lookup.status === "ok" ? lookup.fields : {};
  const merged: Record<string, string> = { ...base };
  for (const field of preset.fields) {
    const submitted = String(form.get(field.key) ?? "").trim();
    if (field.type === "password") {
      // Write-only: a blank password field means "keep the existing secret",
      // never "clear it" — clearing happens only through Disconnect.
      if (submitted) {
        merged[field.key] = submitted;
      }
    } else {
      merged[field.key] = submitted;
    }
  }
  await runtime.credentials.save(id, merged);
  return redirectToSettings(url, `saved=1#source-${id}`);
}

async function handleSourceTestPost(request: Request, runtime: SettingsRuntime, url: URL, id: SourceId): Promise<Response> {
  const form = await request.formData();
  if (!(await csrfOk(request, form, runtime, url))) {
    return new Response("Invalid request.", { status: 403 });
  }
  const result = await testSource(id, runtime.sourceEnv, runtime.credentials);
  const settings = await runtime.repository.get();
  const message = result.ok ? `Test connection succeeded: pulled ${result.count} item${result.count === 1 ? "" : "s"}.` : `Test connection failed: ${result.error}`;
  return htmlResponse(await renderSettingsPage(settings, runtime, url, result.ok ? { notice: message } : { error: message }));
}

async function handleSourceDisconnectPost(request: Request, runtime: SettingsRuntime, url: URL, id: SourceId): Promise<Response> {
  const form = await request.formData();
  if (!(await csrfOk(request, form, runtime, url))) {
    return new Response("Invalid request.", { status: 403 });
  }
  await runtime.credentials.delete(id);
  return redirectToSettings(url, `disconnected=${id}`);
}

function redirectToSettings(url: URL, query: string): Response {
  return new Response(null, { status: 303, headers: { location: `${new URL("/settings", url).toString()}?${query}` } });
}

function parseLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0))];
}

function parseSettings(value: unknown): AppSettings {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const retentionDays = Number(record.retentionDays);
  const timezone = typeof record.timezone === "string" ? record.timezone : "";
  return {
    retentionDays: Number.isInteger(retentionDays) && retentionDays >= 7 && retentionDays <= 3650 ? retentionDays : DEFAULT_SETTINGS.retentionDays,
    syncEnabled: typeof record.syncEnabled === "boolean" ? record.syncEnabled : DEFAULT_SETTINGS.syncEnabled,
    timezone: isValidTimeZone(timezone) ? timezone : DEFAULT_SETTINGS.timezone,
    gmailDomains: asStringArray(record.gmailDomains),
    gmailAllowlist: asStringArray(record.gmailAllowlist),
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isValidTimeZone(timezone: string): boolean {
  if (!timezone) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function isBasicAuthorized(header: string | null, token: string): boolean {
  if (!header?.startsWith("Basic ") || !token) {
    return false;
  }
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    return separator !== -1 && decoded.slice(0, separator) === "unicorn" && constantTimeEqual(decoded.slice(separator + 1), token);
  } catch {
    return false;
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

// --- Rendering -------------------------------------------------------------------

const COMMON_TIMEZONES = [
  "UTC",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Perth",
  "Australia/Adelaide",
  "Australia/Darwin",
  "Australia/Hobart",
  "Asia/Singapore",
  "Asia/Kuala_Lumpur",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Kolkata",
  "Asia/Jakarta",
  "Asia/Dubai",
  "Asia/Bangkok",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "America/Mexico_City",
  "Pacific/Auckland",
  "Pacific/Fiji",
  "Pacific/Honolulu",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
] as const;

interface RenderFlags {
  saved?: boolean;
  notice?: string;
  error?: string;
}

async function renderSettingsPage(settings: AppSettings, runtime: SettingsRuntime, url: URL, flags: RenderFlags): Promise<string> {
  const { connections, status, lastCycle } = runtime;
  const csrf = await computeCsrfToken(runtime.adminToken);
  const sourceStatuses = await buildSourceStatuses(
    runtime.sourceEnv,
    runtime.credentials,
    lastCycle.byPlugin,
    runtime.itemCounts,
    connections.google === true,
  );

  const disconnected = url.searchParams.get("disconnected");
  const syncError = url.searchParams.get("syncError");
  const notice = flags.notice ?? (url.searchParams.has("synced") ? "Sync started — check Sources below in a moment." : disconnected ? `Disconnected ${escapeHtml(disconnected)}.` : flags.saved ? "Changes saved." : undefined);
  const error = flags.error ?? (syncError ? `Sync failed: ${escapeHtml(syncError)}` : undefined);

  const doorUrl = new URL("/mcp", url.origin).toString();

  const body = `
    ${notice ? `<p class="notice" role="status">${notice}</p>` : ""}
    ${error ? `<p class="notice error" role="alert">${error}</p>` : ""}
    ${renderHealthCard(status, lastCycle)}
    ${await renderSourcesSection(sourceStatuses, runtime, csrf)}
    ${renderTimezoneCard(settings, csrf)}
    ${renderGmailScopeCard(settings, csrf)}
    ${renderConnectAgentCard(doorUrl, runtime.mcpToken)}
    ${renderConnectedApps(runtime.oauth?.grants ?? [])}
    ${renderMaintenanceCard(settings, csrf)}
    ${PAGE_STYLE}
    ${PAGE_SCRIPT}`;

  return renderPage({
    title: "unicorn settings",
    active: "/settings",
    heading: "Settings",
    subtitle: "Non-secret behavior for this Worker. Changes apply from the next cycle.",
    body,
  });
}

function renderHealthCard(status: SettingsRuntime["status"], lastCycle: LastCycleInfo): string {
  const schedulerNotice = !status.schedulerRunning
    ? `<p class="notice error" role="alert">The hourly scheduler is not running — nothing will sync. Start it with <code>curl -X POST https://&lt;your-worker&gt;/schedule -H "Authorization: Bearer &lt;ADMIN_TOKEN&gt;"</code>.</p>`
    : "";
  return `
    ${schedulerNotice}
    <section class="card" aria-labelledby="health-title">
      <div class="card-head"><h2 id="health-title">Deployment health</h2></div>
      <div class="card-body">
        <ul class="rail rows">
          <li class="source">
            <span class="dot ${status.schedulerRunning ? "is-live" : "is-off"}" aria-hidden="true"></span>
            <span class="source-name">Hourly scheduler</span>
            <span class="source-state">${status.schedulerRunning ? "Running" : "Stopped"}</span>
          </li>
          <li class="source">
            <span class="dot ${lastCycle.at ? "is-live" : "is-off"}" aria-hidden="true"></span>
            <span class="source-name">Last cycle</span>
            <span class="source-state">${lastCycle.at ? renderTime(lastCycle.at) : "Never run"}</span>
          </li>
        </ul>
      </div>
    </section>`;
}

function renderTime(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(iso)}</time>`;
}

async function renderSourcesSection(statuses: SourceStatus[], runtime: SettingsRuntime, csrf: string): Promise<string> {
  const cards = await Promise.all(statuses.map((status) => renderSourceCard(status, runtime, csrf)));
  return `
    <section aria-labelledby="sources-title">
      <div class="section-head"><h2 id="sources-title">Sources</h2><p class="card-sub">Pick a preset, paste a credential, save. Env secrets set with <code>wrangler secret put</code> always win over anything saved here.</p></div>
      <div class="source-cards">${cards.join("")}</div>
    </section>`;
}

async function renderSourceCard(status: SourceStatus, runtime: SettingsRuntime, csrf: string): Promise<string> {
  if (status.id === "gmail") {
    return renderGmailSourceCard(status, runtime);
  }
  const preset = presetFor(status.id);
  const lookup = await runtime.credentials.get(status.id);
  const prefill = nonSecretPrefill(status.id, runtime.sourceEnv, lookup);
  return renderCredentialSourceCard(status, preset, prefill, csrf);
}

function renderCredentialSourceCard(
  status: SourceStatus,
  preset: ReturnType<typeof presetFor>,
  prefill: Record<string, string>,
  csrf: string,
): string {
  const fieldsHtml = preset.fields
    .map((field) => {
      if (field.type === "select") {
        const current = prefill[field.key] ?? field.options?.[0] ?? "";
        const options = (field.options ?? [])
          .map((option) => `<option value="${escapeHtml(option)}"${option === current ? " selected" : ""}>${escapeHtml(option)}</option>`)
          .join("");
        return `<div class="field"><div class="field-text"><label for="src-${status.id}-${field.key}">${escapeHtml(field.label)}</label></div><div class="field-input"><select id="src-${status.id}-${field.key}" name="${field.key}">${options}</select></div></div>`;
      }
      if (field.type === "password") {
        const placeholder = status.configured ? "Already set — leave blank to keep it" : "Not set";
        return `<div class="field"><div class="field-text"><label for="src-${status.id}-${field.key}">${escapeHtml(field.label)}</label></div><div class="field-input"><input id="src-${status.id}-${field.key}" name="${field.key}" type="password" autocomplete="off" placeholder="${escapeHtml(placeholder)}"></div></div>`;
      }
      const value = escapeHtml(prefill[field.key] ?? "");
      return `<div class="field"><div class="field-text"><label for="src-${status.id}-${field.key}">${escapeHtml(field.label)}</label></div><div class="field-input"><input id="src-${status.id}-${field.key}" name="${field.key}" type="text" placeholder="${escapeHtml(field.placeholder ?? "")}" value="${value}"></div></div>`;
    })
    .join("");

  return `
    <article class="card source-card" id="source-${status.id}" aria-labelledby="source-${status.id}-title">
      <div class="card-head">
        <div class="card-head-row">
          <span class="dot ${status.configured ? "is-live" : "is-off"}" aria-hidden="true"></span>
          <h3 id="source-${status.id}-title">${escapeHtml(status.label)}</h3>
        </div>
        <p class="card-sub">${escapeHtml(preset.instructions)} <a href="${escapeHtml(preset.instructionsUrl)}" target="_blank" rel="noopener">Get one</a></p>
        ${status.needsReentry ? `<p class="notice error" role="alert">Saved credential no longer decrypts (ADMIN_TOKEN may have rotated) — re-enter it below.</p>` : ""}
      </div>
      <div class="card-body">
        <dl class="meta">
          <div><dt>Last sync</dt><dd>${status.lastSyncAt ? renderTime(status.lastSyncAt) : "Never"}</dd></div>
          <div><dt>Last error</dt><dd>${status.lastError ? escapeHtml(status.lastError) : "None"}</dd></div>
          <div><dt>Active items</dt><dd>${status.items}</dd></div>
        </dl>
        <form method="post" action="/settings/sources/${status.id}">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <div class="rows">${fieldsHtml}</div>
          <div class="actions"><button type="submit">Save</button></div>
        </form>
        <div class="card-actions">
          <form method="post" action="/settings/sources/${status.id}/test"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="button ghost" type="submit">Test connection</button></form>
          <form method="post" action="/settings/sources/${status.id}/disconnect" data-confirm="Disconnect ${escapeHtml(status.label)}? Its saved credential will be deleted."><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="button ghost danger" type="submit">Disconnect</button></form>
        </div>
      </div>
    </article>`;
}

// Gmail (ADR-0033) keeps its existing Connect flow rather than a generic
// fields form — the credential is a Google OAuth refresh token in oauth_tokens,
// not something pasted here.
function renderGmailSourceCard(status: SourceStatus, runtime: SettingsRuntime): string {
  const { connections } = runtime;
  const configured = connections.google === true;
  const connected = connections.gmailConnected === true;
  const body = !configured
    ? `<p class="hint">Set <code>PLUGIN_SECRET_GOOGLE_CLIENT_ID</code> and <code>PLUGIN_SECRET_GOOGLE_CLIENT_SECRET</code> with <code>wrangler secret put</code>, then reload this page. See docs/GMAIL.md for the full setup.</p>`
    : connected
      ? `<p class="notice" role="status">Connected — Gmail threads sync on the hourly cycle.</p>`
      : `<p class="hint">Not connected yet.</p><div class="actions"><a class="button" href="/settings/oauth/gmail/start">Connect Gmail</a></div>`;
  return `
    <article class="card source-card" id="source-gmail" aria-labelledby="source-gmail-title">
      <div class="card-head">
        <div class="card-head-row">
          <span class="dot ${connected ? "is-live" : "is-off"}" aria-hidden="true"></span>
          <h3 id="source-gmail-title">Gmail</h3>
        </div>
        <p class="card-sub">Ingests recent threads through Google's Gmail MCP server.</p>
      </div>
      <div class="card-body">
        <dl class="meta">
          <div><dt>Last sync</dt><dd>${status.lastSyncAt ? renderTime(status.lastSyncAt) : "Never"}</dd></div>
          <div><dt>Last error</dt><dd>${status.lastError ? escapeHtml(status.lastError) : "None"}</dd></div>
          <div><dt>Active items</dt><dd>${status.items}</dd></div>
        </dl>
        ${body}
      </div>
    </article>`;
}

function renderTimezoneCard(settings: AppSettings, csrf: string): string {
  const options = new Set<string>([...COMMON_TIMEZONES, settings.timezone]);
  const optionsHtml = [...options]
    .map((zone) => `<option value="${escapeHtml(zone)}"${zone === settings.timezone ? " selected" : ""}>${escapeHtml(zone)}</option>`)
    .join("");
  return `
    <section class="card" aria-labelledby="timezone-title">
      <div class="card-head"><h2 id="timezone-title">Timezone</h2><p class="card-sub">The daily digest runs once this local time reaches 07:00.</p></div>
      <div class="card-body">
        <form method="post" action="/settings/timezone">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <div class="rows">
            <div class="field">
              <div class="field-text"><label for="timezone">IANA timezone</label><p class="hint" data-detected-hint>Detected from your browser on load, if different.</p></div>
              <div class="field-input"><select id="timezone" name="timezone" data-timezone-select>${optionsHtml}</select></div>
            </div>
          </div>
          <div class="actions"><button type="submit">Save timezone</button></div>
        </form>
      </div>
    </section>`;
}

function renderGmailScopeCard(settings: AppSettings, csrf: string): string {
  return `
    <section class="card" aria-labelledby="gmail-scope-title">
      <div class="card-head"><h2 id="gmail-scope-title">Gmail scope</h2><p class="card-sub">Only mail from these domains, from an allowlisted sender, or mentioning a course code, is ever ingested — never the whole inbox.</p></div>
      <div class="card-body">
        <form method="post" action="/settings/gmail-scope">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <div class="rows">
            <div class="field field-stack">
              <label for="gmailDomains">University domains — one per line</label>
              <textarea id="gmailDomains" name="gmailDomains" rows="3" placeholder="monash.edu&#10;student.monash.edu">${escapeHtml(settings.gmailDomains.join("\n"))}</textarea>
              <p class="hint">Leave blank to use a domain guessed from your Moodle/Canvas base URL.</p>
            </div>
            <div class="field field-stack">
              <label for="gmailAllowlist">Allowlisted senders — one per line</label>
              <textarea id="gmailAllowlist" name="gmailAllowlist" rows="3" placeholder="unit-convenor@example.edu">${escapeHtml(settings.gmailAllowlist.join("\n"))}</textarea>
              <p class="hint">Mail mentioning a course code is always included, regardless of these lists.</p>
            </div>
          </div>
          <div class="actions"><button type="submit">Save scope</button></div>
        </form>
      </div>
    </section>`;
}

function renderConnectAgentCard(doorUrl: string, mcpToken: string): string {
  const claudeCodeCommand = `claude mcp add --transport http unicorn ${doorUrl} --header "Authorization: Bearer ${mcpToken}"`;
  return `
    <section class="card" aria-labelledby="connect-title">
      <div class="card-head"><h2 id="connect-title">Connect your agent</h2><p class="card-sub">Full setup: <a href="https://github.com/TuuHub/unicorn/blob/main/docs/CONNECTORS.md" target="_blank" rel="noopener">docs/CONNECTORS.md</a>.</p></div>
      <div class="card-body">
        <div class="rows">
          ${renderCopyRow("Claude Code", claudeCodeCommand)}
          ${renderCopyRow("claude.ai connector URL", doorUrl)}
          ${renderCopyRow("ChatGPT connector URL", doorUrl)}
        </div>
      </div>
    </section>`;
}

function renderCopyRow(label: string, value: string): string {
  return `
    <div class="field copy-row">
      <div class="field-text"><label>${escapeHtml(label)}</label><code class="copy-value">${escapeHtml(value)}</code></div>
      <button type="button" class="button ghost" data-copy="${escapeHtml(value)}">Copy</button>
    </div>`;
}

function renderMaintenanceCard(settings: AppSettings, csrf: string): string {
  return `
    <section class="card" aria-labelledby="maintenance-title">
      <div class="card-head"><h2 id="maintenance-title">Maintenance</h2></div>
      <div class="card-body">
        <form method="post" action="/settings">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <div class="rows">
            <div class="field">
              <div class="field-text"><label for="retentionDays">Hot retention window</label><p class="hint">Days before non-course items move to the archive.</p></div>
              <div class="field-input"><input id="retentionDays" name="retentionDays" type="number" inputmode="numeric" min="7" max="3650" required value="${settings.retentionDays}"><span class="unit">days</span></div>
            </div>
            <div class="field">
              <div class="field-text"><label for="syncEnabled">Source synchronization</label><p class="hint">Pull every enabled source on the hourly cycle.</p></div>
              <input id="syncEnabled" class="switch" name="syncEnabled" type="checkbox" ${settings.syncEnabled ? "checked" : ""}>
            </div>
          </div>
          <div class="actions"><button type="submit">Save changes</button></div>
        </form>
        <form method="post" action="/settings/sync-now" class="sync-now">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <p class="hint">Runs ingestion, labelling, digest and retention right now instead of waiting for the hourly cycle.</p>
          <button type="submit" class="button ghost">Sync now</button>
        </form>
      </div>
    </section>`;
}

const PAGE_STYLE = `
    <style>
      .rail{list-style:none;margin:0;padding:0}
      .source{display:flex;align-items:center;gap:10px;padding:12px 0}
      .dot{width:8px;height:8px;border-radius:50%;flex:none}
      .dot.is-live{background:var(--ok)}
      .dot.is-off{background:var(--track)}
      .source-name{font-weight:500}
      .source-state{margin-left:auto;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums;text-align:right}
      .section-head{margin:32px 0 12px}
      .section-head h2{font-size:16px}
      .source-cards{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
      .source-card{margin-bottom:0}
      .card-head-row{display:flex;align-items:center;gap:8px}
      .card-head-row h3{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}
      .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin:0 0 14px;font-size:13px}
      .meta div{display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--border);padding-top:6px}
      .meta dt{color:var(--muted)}
      .meta dd{margin:0;text-align:right;overflow-wrap:anywhere}
      .card-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
      .card-actions form{margin:0}
      .field{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 0}
      .field-stack{flex-direction:column;align-items:stretch;gap:6px}
      .field-text{min-width:0}
      label{font-weight:500;cursor:pointer}
      .hint{margin:1px 0 0;color:var(--muted);font-size:13px}
      .field-input{display:flex;align-items:center;gap:8px;flex:none}
      input[type=number]{width:84px;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:7px 10px;border-radius:8px;font:inherit;font-size:14px;font-variant-numeric:tabular-nums;text-align:right}
      input[type=text],input[type=password],select{width:220px;max-width:100%;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:7px 10px;border-radius:8px;font:inherit;font-size:14px}
      textarea{width:100%;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:8px 10px;border-radius:8px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
      .unit{color:var(--muted);font-size:13px}
      .switch{appearance:none;flex:none;width:38px;height:22px;margin:0;border-radius:999px;background:var(--track);cursor:pointer;position:relative;transition:background .15s ease-out}
      .switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:translate .15s ease-out}
      .switch:checked{background:var(--ok)}
      .switch:checked::after{translate:16px 0}
      .actions{padding-top:16px;display:flex;justify-content:flex-end}
      .sync-now{margin-top:16px;padding-top:16px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:16px}
      .sync-now .hint{margin:0}
      .button{display:inline-block;border:0;border-radius:8px;background:var(--btn-bg);color:var(--btn-ink);padding:8px 16px;font:inherit;font-size:14px;font-weight:550;text-decoration:none;cursor:pointer;transition:background .15s ease-out}
      .button:hover{background:var(--btn-hover)}
      .button.ghost{background:transparent;color:var(--ink);border:1px solid var(--border)}
      .button.ghost:hover{background:var(--card)}
      .button.ghost.danger{color:#ef4444;border-color:rgba(239,68,68,.35)}
      .copy-row{align-items:center}
      .copy-value{display:block;max-width:min(360px,60vw);overflow-x:auto;white-space:pre;padding:2px 0}
      @media (max-width:640px){
        .field{flex-direction:column;align-items:stretch;gap:8px}
        .field-input{width:100%}
        input[type=text],input[type=password],select{width:100%}
        .copy-value{max-width:100%}
        .meta{grid-template-columns:1fr}
      }
      @media (prefers-reduced-motion:reduce){.switch,.switch::after{transition:none}}
    </style>`;

// Progressive enhancement only (ADR-0026): the page is fully usable with this
// script disabled — copy buttons fall back to selecting the value manually, the
// timezone select's server-rendered options work with no JS at all.
const PAGE_SCRIPT = `
    <script>
      (function () {
        document.querySelectorAll("time[datetime]").forEach(function (node) {
          try {
            node.textContent = new Date(node.getAttribute("datetime")).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
          } catch (_) {}
        });

        document.querySelectorAll("[data-copy]").forEach(function (button) {
          button.addEventListener("click", function () {
            const value = button.getAttribute("data-copy") || "";
            const original = button.textContent;
            navigator.clipboard.writeText(value).then(
              function () { button.textContent = "Copied"; setTimeout(function () { button.textContent = original; }, 1500); },
              function () { button.textContent = "Copy failed"; setTimeout(function () { button.textContent = original; }, 1500); },
            );
          });
        });

        document.querySelectorAll("form[data-confirm]").forEach(function (form) {
          form.addEventListener("submit", function (event) {
            if (!window.confirm(form.getAttribute("data-confirm") || "Are you sure?")) {
              event.preventDefault();
            }
          });
        });

        try {
          const select = document.querySelector("[data-timezone-select]");
          const hint = document.querySelector("[data-detected-hint]");
          if (select && hint) {
            const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const current = select.value;
            if (detected && detected !== current) {
              const already = [].slice.call(select.options).some(function (option) { return option.value === detected; });
              if (!already) {
                const option = document.createElement("option");
                option.value = detected;
                option.textContent = detected;
                select.appendChild(option);
              }
              hint.textContent = "Detected " + detected + " from your browser.";
              const button = document.createElement("button");
              button.type = "button";
              button.className = "button ghost";
              button.textContent = "Use " + detected;
              button.style.marginLeft = "8px";
              button.addEventListener("click", function () {
                if (window.confirm("Set timezone to " + detected + "?")) {
                  select.value = detected;
                }
              });
              hint.appendChild(button);
            }
          }
        } catch (_) {}
      })();
    </script>`;
