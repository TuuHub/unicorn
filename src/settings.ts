import { renderConnectedApps } from "./oauth-server";
import { D1OAuthTokenStore } from "./oauth";
import { icon, sourceTile } from "./marks";
import type { LoginBrowser } from "./moodle-browser";
import { cancelMoodleSignIn, checkMoodleSignIn, startMoodleSignIn, type MoodleSignIn } from "./moodle-sign-in";
import { relative } from "./panel-kit";
import { D1ManifestStore, type StoredPluginManifest } from "./plugins/declarative/store";
import { escapeHtml, htmlResponse, renderPage } from "./ui";
import {
  buildSourceStatuses,
  detectEdRegion,
  nonSecretPrefill,
  PLUGIN_ID,
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
  // Built-in sources the user paused. Their credentials stay saved; the cycle skips them.
  disabledSources: SourceId[];
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
  // POST /settings/start-scheduler: arms the Scheduler DO's hourly alarm.
  startScheduler?: () => Promise<{ ok: boolean; error?: string }>;
  // OAuth connectors (ADR-0035): grants issued by /authorize, for the "Connected apps" card.
  oauth?: { grants: GrantSummary[] };
  // D1, for custom source manifests, the Gmail token and the Moodle sign-in attempt.
  // Without it the page hides custom sources and Moodle sign-in.
  db?: D1Database;
  // Cloudflare Browser Run, for "Sign in to Moodle". Absent when the Worker has no binding.
  browser?: LoginBrowser;
  // Outbound fetch for Ed region detection and the Moodle sign-in check (tests pass a fake).
  fetch?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_TIMEZONE = "Australia/Melbourne";

const DEFAULT_SETTINGS: AppSettings = {
  retentionDays: 180,
  syncEnabled: true,
  timezone: DEFAULT_TIMEZONE,
  gmailDomains: [],
  gmailAllowlist: [],
  disabledSources: [],
};

// Ids a custom manifest may not take: the built-in sources register items under these.
const RESERVED_PLUGIN_IDS = new Set<string>(Object.values(PLUGIN_ID));

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

// The caller authenticates (index.ts gates /settings with admin-auth.ts's requireAdmin).
export async function handleSettings(request: Request, runtime: SettingsRuntime): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/settings") {
    const settings = await runtime.repository.get();
    return htmlResponse(await renderSettingsPage(settings, runtime, url, { saved: url.searchParams.has("saved") }));
  }

  if (path === "/settings/sources/moodle/sign-in" && request.method === "GET") {
    return handleMoodleSignInGet(runtime, url);
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405, headers: { allow: "GET, POST" } });
  }

  const form = await request.formData();
  if (!(await csrfOk(request, form, runtime, url))) {
    return new Response("Invalid request.", { status: 403 });
  }

  if (path === "/settings") return handleMaintenancePost(form, runtime, url);
  if (path === "/settings/timezone") return handleTimezonePost(form, runtime, url);
  if (path === "/settings/gmail-scope") return handleGmailScopePost(form, runtime, url);
  if (path === "/settings/sync-now") return handleSyncNowPost(runtime, url);
  if (path === "/settings/start-scheduler") return handleStartSchedulerPost(runtime, url);
  if (path === "/settings/sources/moodle/sign-in") return handleMoodleSignInPost(form, runtime, url);
  if (path === "/settings/sources/moodle/sign-in/cancel") return handleMoodleSignInCancel(runtime, url);

  const sourceMatch = /^\/settings\/sources\/([a-z]+)(\/test|\/disconnect|\/enabled)?$/.exec(path);
  if (sourceMatch) {
    const [, rawId, action] = sourceMatch;
    if (!isValidSourceId(rawId!)) {
      return json404();
    }
    const id = rawId as SourceId;
    if (action === "/test") return handleSourceTestPost(runtime, url, id);
    if (action === "/disconnect") return handleSourceRemovePost(runtime, url, id);
    if (action === "/enabled") return handleSourceEnabledPost(form, runtime, url, id);
    return handleSourceSavePost(form, runtime, url, id);
  }

  const pluginMatch = /^\/settings\/plugins(?:\/([a-z0-9-]+)(\/enabled|\/remove)?)?$/.exec(path);
  if (pluginMatch && runtime.db) {
    const [, id, action] = pluginMatch;
    const store = new D1ManifestStore(runtime.db);
    if (!id) return handlePluginSavePost(form, runtime, url, store, null);
    if (RESERVED_PLUGIN_IDS.has(id)) return json404();
    if (action === "/enabled") {
      await store.setEnabled(id, form.get("enabled") === "1");
      return redirectToSettings(url, `saved=1#plugin-${id}`);
    }
    if (action === "/remove") {
      await store.delete(id);
      return redirectToSettings(url, `removed=${encodeURIComponent(id)}#sources`);
    }
    return handlePluginSavePost(form, runtime, url, store, id);
  }

  return json404();
}

function isValidSourceId(value: string): value is SourceId {
  return SOURCE_PRESETS.some((preset) => preset.id === value);
}

function json404(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

// --- CSRF ----------------------------------------------------------------------
//
// The page is single-user behind the ADMIN_TOKEN sign-in, so a token bound to the admin
// credential itself is enough: HMAC(ADMIN_TOKEN, "settings-csrf"), verified in
// constant time. The Origin check stays as the second layer for every POST.
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

async function handleMaintenancePost(form: FormData, runtime: SettingsRuntime, url: URL): Promise<Response> {
  const current = await runtime.repository.get();
  const retentionDays = Number(form.get("retentionDays"));
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 3650) {
    return htmlResponse(await renderSettingsPage(current, runtime, url, { error: "Retention must be between 7 and 3650 days." }), 400);
  }
  await runtime.repository.save({ ...current, retentionDays, syncEnabled: form.get("syncEnabled") === "on" });
  return redirectToSettings(url, "saved=1");
}

async function handleTimezonePost(form: FormData, runtime: SettingsRuntime, url: URL): Promise<Response> {
  const current = await runtime.repository.get();
  const timezone = String(form.get("timezone") ?? "").trim();
  if (!isValidTimeZone(timezone)) {
    return htmlResponse(await renderSettingsPage(current, runtime, url, { error: "Timezone must be a valid IANA name, e.g. Australia/Melbourne." }), 400);
  }
  await runtime.repository.save({ ...current, timezone });
  return redirectToSettings(url, "saved=1");
}

async function handleGmailScopePost(form: FormData, runtime: SettingsRuntime, url: URL): Promise<Response> {
  const current = await runtime.repository.get();
  const gmailDomains = parseLines(String(form.get("gmailDomains") ?? ""));
  const gmailAllowlist = parseLines(String(form.get("gmailAllowlist") ?? ""));
  await runtime.repository.save({ ...current, gmailDomains, gmailAllowlist });
  return redirectToSettings(url, "saved=1");
}

async function handleSyncNowPost(runtime: SettingsRuntime, url: URL): Promise<Response> {
  const result = await runtime.runSync?.();
  return redirectToSettings(url, result?.ok === false ? `syncError=${encodeURIComponent(result.error ?? "sync_failed")}` : "synced=1");
}

async function handleStartSchedulerPost(runtime: SettingsRuntime, url: URL): Promise<Response> {
  const result = await runtime.startScheduler?.();
  return redirectToSettings(url, result?.ok === false ? `schedulerError=${encodeURIComponent(result.error ?? "start_failed")}` : "schedulerStarted=1");
}

async function handleSourceSavePost(form: FormData, runtime: SettingsRuntime, url: URL, id: SourceId): Promise<Response> {
  const preset = presetFor(id);
  const lookup = await runtime.credentials.get(id);
  const base = lookup.status === "ok" ? lookup.fields : {};
  const merged: Record<string, string> = { ...base };
  for (const field of preset.fields) {
    const submitted = String(form.get(field.key) ?? "").trim();
    if (field.type === "password") {
      // Write-only: a blank password field means "keep the existing secret",
      // never "clear it" — clearing happens only through Remove.
      if (submitted) {
        merged[field.key] = submitted;
      }
    } else {
      merged[field.key] = submitted;
    }
  }
  // An Ed token works on exactly one regional host; find it now so a wrong token fails here, not at 3am.
  if (id === "ed" && merged.token && merged.token !== base.token) {
    const region = await detectEdRegion(merged.token, runtime.fetch ?? fetch);
    if (!region) {
      const settings = await runtime.repository.get();
      return htmlResponse(
        await renderSettingsPage(settings, runtime, url, { error: "Ed did not accept that token in AU, US or EU. Copy it again from Ed's API tokens page." }),
        400,
      );
    }
    merged.region = region;
  }
  await runtime.credentials.save(id, merged);
  return redirectToSettings(url, `saved=1#source-${id}`);
}

async function handleSourceTestPost(runtime: SettingsRuntime, url: URL, id: SourceId): Promise<Response> {
  const result = await testSource(id, runtime.sourceEnv, runtime.credentials);
  const settings = await runtime.repository.get();
  const label = presetFor(id).label;
  const message = result.ok
    ? `${label} works. It returned ${result.count} item${result.count === 1 ? "" : "s"}.`
    : `${label} test failed: ${result.error}`;
  return htmlResponse(await renderSettingsPage(settings, runtime, url, result.ok ? { notice: message } : { error: message }));
}

async function handleSourceRemovePost(runtime: SettingsRuntime, url: URL, id: SourceId): Promise<Response> {
  if (id === "gmail" && runtime.db) {
    await new D1OAuthTokenStore(runtime.db).delete("gmail");
    await new D1ManifestStore(runtime.db).delete("gmail");
  }
  await runtime.credentials.delete(id);
  const settings = await runtime.repository.get();
  if (settings.disabledSources.includes(id)) {
    await runtime.repository.save({ ...settings, disabledSources: settings.disabledSources.filter((entry) => entry !== id) });
  }
  return redirectToSettings(url, `disconnected=${id}#source-${id}`);
}

async function handleSourceEnabledPost(form: FormData, runtime: SettingsRuntime, url: URL, id: SourceId): Promise<Response> {
  const enabled = form.get("enabled") === "1";
  // Gmail is a manifest, so its switch is the manifest's own enabled flag.
  if (id === "gmail") {
    if (runtime.db) await new D1ManifestStore(runtime.db).setEnabled("gmail", enabled);
    return redirectToSettings(url, "saved=1#source-gmail");
  }
  const settings = await runtime.repository.get();
  const others = settings.disabledSources.filter((entry) => entry !== id);
  await runtime.repository.save({ ...settings, disabledSources: enabled ? others : [...others, id] });
  return redirectToSettings(url, `saved=1#source-${id}`);
}

async function handlePluginSavePost(form: FormData, runtime: SettingsRuntime, url: URL, store: D1ManifestStore, editing: string | null): Promise<Response> {
  const draft = String(form.get("manifest") ?? "").trim();
  const fail = async (error: string) => {
    const settings = await runtime.repository.get();
    return htmlResponse(await renderSettingsPage(settings, runtime, url, { manifestDraft: { id: editing, text: draft, error } }), 400);
  };
  let value: unknown;
  try {
    value = JSON.parse(draft);
  } catch {
    return fail("That manifest is not valid JSON.");
  }
  const id = value && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
  if (typeof id === "string" && RESERVED_PLUGIN_IDS.has(id)) {
    return fail(`"${id}" belongs to a built-in source. Pick another id.`);
  }
  if (editing && id !== editing) {
    return fail(`Keep the id "${editing}". To use a new id, add it as a new source.`);
  }
  if (!editing && typeof id === "string" && (await store.list()).some((stored) => stored.id === id)) {
    return fail(`A source with the id "${id}" already exists. Edit it on its card.`);
  }
  try {
    const current = editing ? (await store.list()).find((stored) => stored.id === editing) : undefined;
    const saved = await store.upsert(value, current?.enabled ?? true);
    return redirectToSettings(url, `saved=1#plugin-${saved.id}`);
  } catch (error) {
    return fail(manifestError(error));
  }
}

// zod reports every issue; the first one, with its path, is enough to fix the manifest.
function manifestError(error: unknown): string {
  const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues;
  if (Array.isArray(issues) && issues[0]) {
    const path = issues[0].path.map(String).join(".");
    return path ? `In "${path}": ${issues[0].message}` : issues[0].message;
  }
  return error instanceof Error ? error.message : String(error);
}

// --- Moodle sign-in ---------------------------------------------------------------

function moodleSignIn(runtime: SettingsRuntime, baseUrl: string): MoodleSignIn | null {
  if (!runtime.db || !runtime.browser) return null;
  return {
    db: runtime.db,
    browser: runtime.browser,
    credentials: runtime.credentials,
    baseUrl,
    fetch: runtime.fetch,
    now: runtime.now ? () => runtime.now!().getTime() : undefined,
  };
}

async function moodleBaseUrl(runtime: SettingsRuntime, submitted?: string): Promise<string | null> {
  const raw = submitted?.trim() || nonSecretPrefill("moodle", runtime.sourceEnv, await runtime.credentials.get("moodle")).baseUrl || "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

async function handleMoodleSignInPost(form: FormData, runtime: SettingsRuntime, url: URL): Promise<Response> {
  const baseUrl = await moodleBaseUrl(runtime, String(form.get("baseUrl") ?? ""));
  const settings = await runtime.repository.get();
  if (!baseUrl) {
    return htmlResponse(await renderSettingsPage(settings, runtime, url, { error: "Enter your Moodle address, starting with https://." }), 400);
  }
  const signIn = moodleSignIn(runtime, baseUrl);
  if (!signIn) return json404();
  const state = await startMoodleSignIn(signIn);
  if (state.state === "failed") {
    return htmlResponse(await renderSettingsPage(settings, runtime, url, { error: state.error }), 502);
  }
  return new Response(null, { status: 303, headers: { location: new URL("/settings/sources/moodle/sign-in", url).toString() } });
}

async function handleMoodleSignInGet(runtime: SettingsRuntime, url: URL): Promise<Response> {
  const signIn = moodleSignIn(runtime, "");
  if (!signIn) return json404();
  const state = await checkMoodleSignIn(signIn);
  if (state.state === "none") return redirectToSettings(url, "#source-moodle");
  if (state.state === "done") return redirectToSettings(url, "signedIn=moodle#source-moodle");
  if (state.state === "failed") {
    const settings = await runtime.repository.get();
    return htmlResponse(await renderSettingsPage(settings, runtime, url, { error: state.error }));
  }
  const csrf = await computeCsrfToken(runtime.adminToken);
  const now = runtime.now?.() ?? new Date();
  const response = htmlResponse(renderMoodleWaitingPage(state.liveViewUrl, relative(new Date(state.expiresAt).toISOString(), now), csrf));
  // The CSP allows no fetch, so the page polls by reloading itself.
  response.headers.set("refresh", "4");
  return response;
}

async function handleMoodleSignInCancel(runtime: SettingsRuntime, url: URL): Promise<Response> {
  const signIn = moodleSignIn(runtime, "");
  if (signIn) await cancelMoodleSignIn(signIn);
  return redirectToSettings(url, "#source-moodle");
}

function renderMoodleWaitingPage(liveViewUrl: string, closesIn: string, csrf: string): string {
  const body = `
    <section class="card signin" aria-labelledby="signin-title">
      <div class="card-body">
        ${sourceTile("moodle", "lg")}
        <h2 id="signin-title">Sign in to Moodle in the window that opens</h2>
        <p class="signin-copy">Moodle runs in a private browser on Cloudflare. Sign in there the way you always do, Okta and two-factor included. This page notices when you're in and closes that browser.</p>
        <div class="signin-actions">
          <a class="button lg" href="${escapeHtml(liveViewUrl)}" target="_blank" rel="noopener">${icon("external")}<span>Open Moodle sign-in</span></a>
          <form method="post" action="/settings/sources/moodle/sign-in/cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="button ghost lg" type="submit">Cancel</button></form>
        </div>
        <p class="signin-wait"><span class="pulse" aria-hidden="true"></span>Waiting for Moodle. The window closes ${escapeHtml(closesIn)}.</p>
      </div>
    </section>
    <style>
      .signin{max-width:560px;margin:24px auto 0;text-align:center}
      .signin .card-body{padding:40px 32px 32px;align-items:center}
      .signin h2{margin:20px 0 8px;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em}
      .signin-copy{margin:0 auto 24px;max-width:44ch;color:var(--muted)}
      .signin-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
      .signin-actions form{margin:0}
      .signin-wait{display:flex;align-items:center;justify-content:center;gap:8px;margin:24px 0 0;color:var(--muted);font-size:13px}
      .pulse{width:7px;height:7px;border-radius:50%;background:var(--fg);animation:pulse 1.4s ease-in-out infinite}
      @keyframes pulse{50%{opacity:.25}}
      @media (prefers-reduced-motion:reduce){.pulse{animation:none}}
    </style>`;
  return renderPage({ title: "unicorn — sign in to Moodle", active: "/settings", heading: "Moodle", subtitle: "Signing in through a private browser.", body, wide: true });
}

function redirectToSettings(url: URL, query: string): Response {
  return new Response(null, { status: 303, headers: { location: `${new URL("/settings", url).toString()}${query.startsWith("#") ? "" : "?"}${query}` } });
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
    disabledSources: asStringArray(record.disabledSources).filter(isValidSourceId),
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
  // A manifest that failed to save, put back in the box it came from (null id = the add card).
  manifestDraft?: { id: string | null; text: string; error: string };
}

interface PageContext {
  settings: AppSettings;
  runtime: SettingsRuntime;
  csrf: string;
  now: Date;
  hosted: boolean;
  manifests: StoredPluginManifest[];
  draft?: RenderFlags["manifestDraft"];
}

async function renderSettingsPage(settings: AppSettings, runtime: SettingsRuntime, url: URL, flags: RenderFlags): Promise<string> {
  const { connections, status, lastCycle } = runtime;
  const csrf = await computeCsrfToken(runtime.adminToken);
  const sourceStatuses = await buildSourceStatuses(runtime.sourceEnv, runtime.credentials, lastCycle.byPlugin, runtime.itemCounts, connections.google === true);
  const manifests = runtime.db ? await new D1ManifestStore(runtime.db).list() : [];
  const context: PageContext = {
    settings,
    runtime,
    csrf,
    now: runtime.now?.() ?? new Date(),
    hosted: Boolean((runtime.sourceEnv as { HOSTED?: string }).HOSTED),
    manifests,
    draft: flags.manifestDraft,
  };

  const disconnected = url.searchParams.get("disconnected");
  const removed = url.searchParams.get("removed");
  const syncError = url.searchParams.get("syncError");
  const schedulerError = url.searchParams.get("schedulerError");
  const notice =
    flags.notice ??
    (url.searchParams.has("synced")
      ? "Sync started. Sources update in a moment."
      : url.searchParams.has("schedulerStarted")
        ? "Hourly sync is on."
        : url.searchParams.get("signedIn") === "moodle"
          ? "Signed in to Moodle."
          : disconnected && isValidSourceId(disconnected)
            ? `Removed ${escapeHtml(presetFor(disconnected).label)}.`
            : removed
              ? `Removed ${escapeHtml(removed)}.`
              : flags.saved
                ? "Saved."
                : undefined);
  const error = flags.error ?? (syncError ? `Sync failed: ${escapeHtml(syncError)}` : schedulerError ? `Hourly sync did not start: ${escapeHtml(schedulerError)}` : undefined);

  const body = `
    ${notice ? `<p class="notice" role="status">${notice}</p>` : ""}
    ${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ""}
    ${renderSyncBar(status, lastCycle, csrf, context.now)}
    ${await renderSourcesSection(sourceStatuses, context)}
    <h2 class="group-title">Settings</h2>
    <div class="grid2">
      ${renderTimezoneCard(settings, csrf)}
      ${renderMaintenanceCard(settings, csrf)}
    </div>
    ${renderGmailScopeCard(settings, csrf)}
    ${renderConnectedApps(runtime.oauth?.grants ?? [])}
    ${PAGE_STYLE}
    ${PAGE_SCRIPT}`;

  return renderPage({
    title: "unicorn — sources",
    active: "/settings",
    heading: "Sources",
    subtitle: "Where unicorn reads from.",
    body,
    wide: true,
  });
}

// One line for the scheduler: calm when it runs, the page's only red when it doesn't.
function renderSyncBar(status: SettingsRuntime["status"], lastCycle: LastCycleInfo, csrf: string, now: Date): string {
  const last = lastCycle.at ? `Last ran <time datetime="${escapeHtml(lastCycle.at)}">${escapeHtml(relative(lastCycle.at, now))}</time>.` : "It has not run yet.";
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  if (!status.schedulerRunning) {
    return `
      <div class="sync-bar stopped" role="alert">
        <span class="dot bad" aria-hidden="true"></span>
        <p><strong>Hourly sync is stopped.</strong> ${last}</p>
        <form method="post" action="/settings/start-scheduler">${hidden}<button class="button sm" type="submit">Start hourly sync</button></form>
      </div>`;
  }
  return `
    <div class="sync-bar">
      <span class="dot" aria-hidden="true"></span>
      <p>Syncing every hour. ${last}</p>
      <form method="post" action="/settings/sync-now">${hidden}<button class="button ghost sm" type="submit">${icon("sync")}<span>Sync now</span></button></form>
    </div>`;
}

// Preset instructions are plain text (ADR-0038 data, not markup) but a couple
// name a literal command — escape first, then turn `backticked` spans into <code>.
function renderInlineCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

type Tone = "ok" | "bad" | "idle";

interface CardState {
  tone: Tone;
  text: string;
}

function syncState(input: { lastSyncAt: string | null; lastError: string | null; items: number }, now: Date): CardState {
  if (input.lastError) return { tone: "bad", text: "Last sync failed" };
  const items = `${input.items} item${input.items === 1 ? "" : "s"}`;
  if (input.lastSyncAt) return { tone: "ok", text: `Synced ${relative(input.lastSyncAt, now)} · ${items}` };
  return { tone: "ok", text: `Never synced · ${items}` };
}

function builtInState(status: SourceStatus, enabled: boolean, now: Date): CardState {
  if (status.needsReentry) return { tone: "bad", text: "Saved token no longer works" };
  if (!status.configured) return { tone: "idle", text: "Not connected" };
  if (!enabled) return { tone: "idle", text: "Paused" };
  return syncState(status, now);
}

async function renderSourcesSection(statuses: SourceStatus[], context: PageContext): Promise<string> {
  const builtIns = await Promise.all(statuses.map((status) => renderBuiltInCard(status, context)));
  const custom = context.manifests.filter((stored) => !RESERVED_PLUGIN_IDS.has(stored.id)).map((stored) => renderPluginCard(stored, context));
  const add = context.runtime.db ? renderAddPluginCard(context) : "";
  return `
    <section id="sources" class="src-grid" aria-label="Sources">${[...builtIns, ...custom, add].join("")}</section>`;
}

function renderCard(input: {
  id: string;
  tile: string;
  name: string;
  state: CardState;
  toggle?: { action: string; enabled: boolean };
  error?: string | null;
  body: string;
  foot?: string;
  csrf: string;
  extraClass?: string;
  // The card the user just submitted with a problem: the page scrolls to it.
  focus?: boolean;
}): string {
  const paused = input.toggle && !input.toggle.enabled;
  const toggle = input.toggle
    ? `<form method="post" action="${input.toggle.action}" class="toggle-form">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
        <input type="hidden" name="enabled" value="${input.toggle.enabled ? "0" : "1"}">
        <button type="submit" class="toggle" role="switch" aria-checked="${input.toggle.enabled}" aria-label="Sync ${escapeHtml(input.name)}" title="${input.toggle.enabled ? "Pause" : "Resume"} ${escapeHtml(input.name)}"><span></span></button>
      </form>`
    : "";
  return `
    <article class="card src${paused ? " paused" : ""}${input.extraClass ? ` ${input.extraClass}` : ""}" id="${input.id}" aria-labelledby="${input.id}-title"${input.focus ? " data-focus" : ""}>
      <div class="src-head">
        ${input.tile}
        <div class="src-title">
          <h3 id="${input.id}-title">${escapeHtml(input.name)}</h3>
          <p class="src-state"><span class="dot ${input.state.tone}" aria-hidden="true"></span>${escapeHtml(input.state.text)}</p>
        </div>
        ${toggle}
      </div>
      <div class="src-body">
        ${input.error ? `<p class="src-error">${escapeHtml(input.error)}</p>` : ""}
        ${input.body}
      </div>
      ${input.foot ? `<div class="src-foot">${input.foot}</div>` : ""}
    </article>`;
}

function hiddenCsrf(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

function removeForm(action: string, name: string, csrf: string, consequence: string): string {
  return `<form method="post" action="${action}" data-confirm="Remove ${escapeHtml(name)}? ${escapeHtml(consequence)}">${hiddenCsrf(csrf)}<button class="button quiet-danger sm" type="submit">Remove</button></form>`;
}

async function renderBuiltInCard(status: SourceStatus, context: PageContext): Promise<string> {
  if (status.id === "gmail") return renderGmailCard(status, context);
  const { runtime, csrf, settings, now } = context;
  const preset = presetFor(status.id);
  const lookup = await runtime.credentials.get(status.id);
  const prefill = nonSecretPrefill(status.id, runtime.sourceEnv, lookup);
  const enabled = !settings.disabledSources.includes(status.id);
  const stored = lookup.status !== "none";
  const instructions = context.hosted && preset.hostedInstructions ? preset.hostedInstructions : preset.instructions;
  const how = `<p class="src-how">${renderInlineCode(instructions)} <a href="${escapeHtml(preset.instructionsUrl)}" target="_blank" rel="noopener">${status.id === "moodle" ? "How" : "Get one"}</a></p>`;
  const credentialForm = renderCredentialForm(status, preset, prefill, csrf);

  let body: string;
  if (status.id === "moodle" && runtime.browser && runtime.db) {
    const signIn = `
      <form method="post" action="/settings/sources/moodle/sign-in" class="stack">
        ${hiddenCsrf(csrf)}
        ${status.configured ? `<input type="hidden" name="baseUrl" value="${escapeHtml(prefill.baseUrl ?? "")}">` : fieldHtml(`src-moodle-signin-base`, "baseUrl", "Moodle address", "text", prefill.baseUrl ?? "", "https://learning.monash.edu")}
        <div class="row-end"><button class="button${status.configured ? " ghost" : ""}" type="submit">${status.configured ? "Sign in again" : "Sign in to Moodle"}</button></div>
      </form>`;
    body = status.configured
      ? `<p class="src-how">Moodle sessions expire after a few days of no use. Sign in again when sync starts failing.</p>${signIn}${details("Paste a session cookie instead", `${how}${credentialForm}`)}`
      : `<p class="src-how">Sign in as usual. unicorn keeps the session.</p>${signIn}${details("Other ways to connect", `${how}${credentialForm}`)}`;
  } else {
    body = status.configured ? details(status.id === "ed" ? "Replace token" : "Change details", `${how}${credentialForm}`) : `${how}${credentialForm}`;
  }

  const foot = status.configured
    ? `<form method="post" action="/settings/sources/${status.id}/test">${hiddenCsrf(csrf)}<button class="button ghost sm" type="submit">Test connection</button></form>
       ${stored ? removeForm(`/settings/sources/${status.id}/disconnect`, preset.label, csrf, "Its saved credential is deleted. Items already synced stay.") : `<span class="src-note">Set by a Worker secret</span>`}`
    : "";

  return renderCard({
    id: `source-${status.id}`,
    tile: sourceTile(status.id, "lg"),
    name: preset.label,
    state: builtInState(status, enabled, now),
    toggle: status.configured ? { action: `/settings/sources/${status.id}/enabled`, enabled } : undefined,
    error: status.needsReentry ? "Saved credential no longer decrypts (ADMIN_TOKEN may have rotated). Paste it again." : enabled ? status.lastError : null,
    body,
    foot,
    csrf,
  });
}

function details(summary: string, content: string): string {
  return `<details class="src-more"><summary><span>${escapeHtml(summary)}</span></summary><div class="src-more-body">${content}</div></details>`;
}

function fieldHtml(id: string, name: string, label: string, type: "text" | "password", value: string, placeholder: string): string {
  return `<div class="field-stack"><label for="${id}">${escapeHtml(label)}</label><input id="${id}" name="${name}" type="${type}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}"${type === "text" ? ` value="${escapeHtml(value)}"` : ""}></div>`;
}

function renderCredentialForm(status: SourceStatus, preset: ReturnType<typeof presetFor>, prefill: Record<string, string>, csrf: string): string {
  const fields = preset.fields
    .map((field) => {
      const id = `src-${status.id}-${field.key}`;
      if (field.type === "password") {
        return fieldHtml(id, field.key, field.label, "password", "", status.configured ? "Saved. Paste a new one to replace it" : "Paste it here");
      }
      return fieldHtml(id, field.key, field.label, "text", prefill[field.key] ?? "", field.placeholder ?? "");
    })
    .join("");
  return `
    <form method="post" action="/settings/sources/${status.id}" class="stack">
      ${hiddenCsrf(csrf)}
      ${fields}
      <div class="row-end"><button class="button${status.configured ? " ghost" : ""}" type="submit">${status.configured ? "Save" : "Connect"}</button></div>
    </form>`;
}

// Gmail (ADR-0033) connects through Google OAuth rather than a pasted credential.
function renderGmailCard(status: SourceStatus, context: PageContext): string {
  const { runtime, csrf, now } = context;
  const configured = runtime.connections.google === true;
  const connected = runtime.connections.gmailConnected === true;
  const enabled = context.manifests.find((stored) => stored.id === "gmail")?.enabled ?? true;
  const state: CardState = !configured
    ? { tone: "idle", text: "Not set up" }
    : !connected
      ? { tone: "idle", text: "Not connected" }
      : !enabled
        ? { tone: "idle", text: "Paused" }
        : syncState(status, now);
  const body = !configured
    ? context.hosted
      ? `<p class="src-how">This server has no Google sign-in yet.</p>`
      : `<p class="src-how">Needs <code>PLUGIN_SECRET_GOOGLE_CLIENT_ID</code> and its secret on this Worker. <a href="https://unicorn.tuuhub.com/docs/unicorn/sources#gmail" target="_blank" rel="noopener">How</a></p>`
    : connected
      ? `<p class="src-how">Reads only mail that matches your Gmail scope below, never the whole inbox.</p>`
      : `<p class="src-how">Reads only mail from your university, from senders you allow, or that mentions a unit code.</p><div class="row-end"><a class="button" href="/settings/oauth/gmail/start">Connect Gmail</a></div>`;
  const foot = connected
    ? `<a class="button ghost sm" href="/settings/oauth/gmail/start">Reconnect</a>${runtime.db ? removeForm("/settings/sources/gmail/disconnect", "Gmail", csrf, "unicorn forgets its Google token. Items already synced stay.") : ""}`
    : "";
  return renderCard({
    id: "source-gmail",
    tile: sourceTile("gmail", "lg"),
    name: "Gmail",
    state,
    toggle: connected && runtime.db ? { action: "/settings/sources/gmail/enabled", enabled } : undefined,
    error: connected && enabled ? status.lastError : null,
    body,
    foot,
    csrf,
  });
}

function describeManifest(stored: StoredPluginManifest): string {
  const manifest = stored.manifest;
  if ("transport" in manifest) {
    return `Calls <code>${escapeHtml(manifest.transport.tool)}</code> on ${escapeHtml(hostOf(manifest.transport.url))}.`;
  }
  return `${manifest.format === "rss" ? "Reads the feed" : "Reads JSON"} from ${escapeHtml(hostOf(manifest.url))}.`;
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function renderPluginCard(stored: StoredPluginManifest, context: PageContext): string {
  const { runtime, csrf, now, draft } = context;
  const cycle = runtime.lastCycle.byPlugin[stored.id];
  const state = stored.enabled ? syncState({ lastSyncAt: cycle?.lastSyncAt ?? null, lastError: cycle?.lastError ?? null, items: runtime.itemCounts[stored.id] ?? 0 }, now) : { tone: "idle" as const, text: "Paused" };
  const text = draft?.id === stored.id ? draft.text : JSON.stringify(stored.manifest, null, 2);
  const editor = `
    <form method="post" action="/settings/plugins/${escapeHtml(stored.id)}" class="stack">
      ${hiddenCsrf(csrf)}
      <textarea name="manifest" rows="12" spellcheck="false" class="code" aria-label="Manifest for ${escapeHtml(stored.name)}">${escapeHtml(text)}</textarea>
      <div class="row-end"><button class="button ghost" type="submit">Save manifest</button></div>
    </form>`;
  const body = `<p class="src-how">${describeManifest(stored)}</p>${draft?.id === stored.id ? `<details class="src-more" open><summary><span>Edit manifest</span></summary><div class="src-more-body">${editor}</div></details>` : details("Edit manifest", editor)}`;
  return renderCard({
    id: `plugin-${stored.id}`,
    tile: sourceTile(stored.id, "lg"),
    name: stored.name,
    state,
    toggle: { action: `/settings/plugins/${escapeHtml(stored.id)}/enabled`, enabled: stored.enabled },
    error: draft?.id === stored.id ? draft.error : stored.enabled ? cycle?.lastError : null,
    focus: draft?.id === stored.id,
    body,
    foot: removeForm(`/settings/plugins/${escapeHtml(stored.id)}/remove`, stored.name, csrf, "Its manifest is deleted. Items already synced stay."),
    csrf,
  });
}

const EXAMPLE_MANIFEST = JSON.stringify(
  {
    version: 1,
    id: "faculty-news",
    name: "Faculty news",
    format: "rss",
    url: "https://example.edu/news/feed.xml",
    mapping: {
      id: { path: "guid" },
      kind: { value: "announcement" },
      title: { path: "title" },
      timestamp: { path: "publishedAt" },
      url: { path: "link" },
      body: { path: "description" },
    },
  },
  null,
  2,
);

function renderAddPluginCard(context: PageContext): string {
  const failed = context.draft?.id === null ? context.draft : undefined;
  return `
    <article class="card src src-add" id="add-source" aria-labelledby="add-source-title"${failed ? " data-focus" : ""}>
      <div class="src-head">
        <span class="tile-mark lg mono">${icon("plus")}</span>
        <div class="src-title">
          <h3 id="add-source-title">Add a source</h3>
          <p class="src-state">A feed, a JSON API or an MCP tool</p>
        </div>
      </div>
      <div class="src-body">
        ${failed ? `<p class="src-error" role="alert">${escapeHtml(failed.error)}</p>` : ""}
        <form method="post" action="/settings/plugins" class="stack">
          ${hiddenCsrf(context.csrf)}
          <div class="label-row"><label for="new-manifest">Manifest</label><a href="https://unicorn.tuuhub.com/docs/unicorn/custom-tools" target="_blank" rel="noopener">Format${icon("external", "i ext")}</a></div>
          <textarea id="new-manifest" name="manifest" rows="9" spellcheck="false" class="code" placeholder="${escapeHtml(EXAMPLE_MANIFEST)}">${escapeHtml(failed?.text ?? "")}</textarea>
          <p class="hint">Keys go in <code>PLUGIN_SECRET_*</code> Worker secrets, not here.</p>
          <div class="row-end"><button class="button" type="submit">Add source</button></div>
        </form>
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
      <div class="card-head"><h2 id="timezone-title">Timezone</h2><p class="card-sub">The daily digest arrives at 07:00 here.</p></div>
      <div class="card-body">
        <form method="post" action="/settings/timezone" class="stack grow">
          ${hiddenCsrf(csrf)}
          <div class="field-stack">
            <label for="timezone">Timezone</label>
            <select id="timezone" name="timezone" data-timezone-select>${optionsHtml}</select>
            <p class="hint" data-detected-hint></p>
          </div>
          <div class="row-end"><button class="button ghost" type="submit">Save</button></div>
        </form>
      </div>
    </section>`;
}

function renderGmailScopeCard(settings: AppSettings, csrf: string): string {
  return `
    <section class="card" aria-labelledby="gmail-scope-title">
      <div class="card-head"><h2 id="gmail-scope-title">Gmail scope</h2><p class="card-sub">Only mail from these domains, from an allowed sender, or mentioning a unit code is read. Never the whole inbox.</p></div>
      <div class="card-body">
        <form method="post" action="/settings/gmail-scope" class="stack">
          ${hiddenCsrf(csrf)}
          <div class="scope-grid">
            <div class="field-stack">
              <label for="gmailDomains">University domains</label>
              <textarea id="gmailDomains" name="gmailDomains" rows="3" placeholder="monash.edu&#10;student.monash.edu">${escapeHtml(settings.gmailDomains.join("\n"))}</textarea>
              <p class="hint">One per line. Blank uses the domain of your Moodle or Canvas address.</p>
            </div>
            <div class="field-stack">
              <label for="gmailAllowlist">Allowed senders</label>
              <textarea id="gmailAllowlist" name="gmailAllowlist" rows="3" placeholder="unit-convenor@example.edu">${escapeHtml(settings.gmailAllowlist.join("\n"))}</textarea>
              <p class="hint">One per line. Mail that mentions a unit code is always read.</p>
            </div>
          </div>
          <div class="row-end"><button class="button ghost" type="submit">Save</button></div>
        </form>
      </div>
    </section>`;
}

function renderMaintenanceCard(settings: AppSettings, csrf: string): string {
  return `
    <section class="card" aria-labelledby="maintenance-title">
      <div class="card-head"><h2 id="maintenance-title">Sync and storage</h2><p class="card-sub">How unicorn pulls and how long it keeps things.</p></div>
      <div class="card-body">
        <form method="post" action="/settings" class="stack grow">
          ${hiddenCsrf(csrf)}
          <div class="field-line">
            <div><label for="syncEnabled">Pull sources every hour</label><p class="hint">Off keeps everything but stops pulling.</p></div>
            <input id="syncEnabled" class="switch" name="syncEnabled" type="checkbox" role="switch"${settings.syncEnabled ? " checked" : ""}>
          </div>
          <div class="field-line">
            <div><label for="retentionDays">Keep items for</label><p class="hint">Older non-unit items move to the archive.</p></div>
            <div class="with-unit"><input id="retentionDays" name="retentionDays" type="number" inputmode="numeric" min="7" max="3650" required value="${settings.retentionDays}"><span class="unit">days</span></div>
          </div>
          <div class="row-end"><button class="button ghost" type="submit">Save</button></div>
        </form>
      </div>
    </section>`;
}

const PAGE_STYLE = `
    <style>
      .sync-bar{display:flex;align-items:center;gap:12px;min-height:52px;padding:8px 8px 8px 16px;margin:0 0 16px;border-radius:16px;background:var(--surface);box-shadow:var(--shadow)}
      .sync-bar p{margin:0;flex:1;min-width:0;color:var(--muted);font-size:13.5px}
      .sync-bar strong{color:var(--fg);font-weight:500}
      .sync-bar form{margin:0}
      .sync-bar.stopped p{color:var(--fg-2)}
      .dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--fg)}
      .dot.idle{background:transparent;box-shadow:inset 0 0 0 1.5px var(--faint)}
      .dot.bad{background:var(--danger)}

      .src-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(min(360px,100%),1fr));align-items:stretch;margin:0 0 40px}
      .src{display:flex;flex-direction:column;height:auto;margin:0}
      .src-head{display:flex;align-items:center;gap:12px;padding:16px 16px 0}
      .src-title{flex:1;min-width:0}
      .src-title h3{margin:0;font-size:15px;line-height:22px;font-weight:600;letter-spacing:-.01em}
      .src-state{display:flex;align-items:center;gap:7px;margin:1px 0 0;color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .src.paused .tile-mark{filter:grayscale(1);opacity:.55}
      .src-body{flex:1;display:flex;flex-direction:column;gap:12px;padding:14px 16px 16px}
      .src-how{margin:0;color:var(--muted);font-size:13px;line-height:20px}
      .src-how a,.hint a{color:var(--fg);text-decoration:underline;text-decoration-color:var(--faint);text-underline-offset:3px}
      .src-error{margin:0;padding:8px 10px;border-radius:10px;background:var(--danger-soft);color:var(--danger-text);font-size:12.5px;overflow-wrap:anywhere}
      .src-foot{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid var(--separator)}
      .src-foot form{margin:0}
      .src-foot>:last-child{margin-left:auto}
      .src-foot>:only-child{margin-left:0}
      .src-note{color:var(--faint);font-size:12.5px}
      .button.quiet-danger{background:transparent;color:var(--danger-text)}
      .button.quiet-danger:hover{background:var(--danger-soft)}

      .src-more{margin-top:auto}
      .src-more summary{color:var(--fg);font-weight:500}
      .src-more-body{display:flex;flex-direction:column;gap:12px;padding-top:12px}

      .label-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
      .label-row a{display:inline-flex;align-items:center;gap:2px;color:var(--muted);font-size:12.5px}
      .label-row a:hover{color:var(--fg)}
      .label-row .ext{width:13px;height:13px}
      .src-add{grid-column:1/-1;box-shadow:inset 0 0 0 1px var(--border);background:transparent}
      .src-add .src-state{white-space:normal}

      .stack{display:flex;flex-direction:column;gap:12px;margin:0}
      .stack.grow{flex:1}
      .stack.grow>.row-end{margin-top:auto}
      .field-stack{display:flex;flex-direction:column;gap:6px;min-width:0}
      .field-stack label,.stack>label,.field-line label{font-size:13px;font-weight:500;cursor:pointer}
      .field-stack input,.field-stack select,.field-stack textarea{width:100%}
      .row-end{display:flex;justify-content:flex-end;gap:8px}
      textarea.code::placeholder{color:var(--faint)}
      textarea.code{font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;min-height:180px;resize:vertical;tab-size:2}
      .hint{margin:0;color:var(--muted);font-size:12.5px;line-height:18px}
      .hint:empty{display:none}

      .group-title{margin:0 0 12px;font-size:16px;line-height:24px;font-weight:500}
      .field-line{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:4px 0}
      .with-unit{display:flex;align-items:center;gap:8px}
      .with-unit input{width:84px;text-align:right;font-variant-numeric:tabular-nums}
      .unit{color:var(--muted);font-size:13px}
      .scope-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
      .card .card-head h2{font-size:16px;line-height:24px;font-weight:500;margin:0}

      .toggle-form{margin:0;flex:none}
      .toggle,.switch{appearance:none;flex:none;position:relative;width:40px;height:24px;margin:0;padding:0;border:0;border-radius:999px;background:var(--default);box-shadow:inset 0 0 0 1.5px var(--faint);cursor:pointer;transition:background-color .15s ease-out,box-shadow .15s ease-out}
      .toggle span,.switch::after{content:"";position:absolute;top:6px;left:6px;width:12px;height:12px;border-radius:50%;background:var(--faint);transition:all .2s cubic-bezier(.23,1,.32,1)}
      .toggle[aria-checked=true],.switch:checked{background:var(--fg);box-shadow:none}
      .toggle[aria-checked=true] span,.switch:checked::after{top:3px;left:19px;width:18px;height:18px;background:var(--surface)}
      .toggle:focus-visible,.switch:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
      @media (prefers-reduced-motion:reduce){.toggle span,.switch::after{transition:none}}

      @media (max-width:640px){
        .sync-bar{flex-wrap:wrap;padding:12px 12px 12px 16px}
        .sync-bar p{flex-basis:calc(100% - 24px)}
        .sync-bar form{margin-left:19px}
        .scope-grid{grid-template-columns:1fr}
      }
    </style>`;

// Progressive enhancement only (ADR-0026): the page works with this script disabled.
const PAGE_SCRIPT = `
    <script>
      (function () {
        document.querySelectorAll("form[data-confirm]").forEach(function (form) {
          form.addEventListener("submit", function (event) {
            if (!window.confirm(form.getAttribute("data-confirm") || "Are you sure?")) {
              event.preventDefault();
            }
          });
        });

        var target = document.querySelector("[data-focus]") || (location.hash && document.querySelector(location.hash));
        if (target && target.scrollIntoView) target.scrollIntoView({ block: "center" });

        try {
          var select = document.querySelector("[data-timezone-select]");
          var hint = document.querySelector("[data-detected-hint]");
          if (select && hint) {
            var detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (detected && detected !== select.value) {
              var button = document.createElement("button");
              button.type = "button";
              button.className = "button ghost xs";
              button.textContent = "Use " + detected;
              button.addEventListener("click", function () {
                if (![].slice.call(select.options).some(function (option) { return option.value === detected; })) {
                  var option = document.createElement("option");
                  option.value = detected;
                  option.textContent = detected;
                  select.appendChild(option);
                }
                select.value = detected;
                hint.textContent = "Save to switch to " + detected + ".";
              });
              hint.textContent = "Your browser is in " + detected + ". ";
              hint.appendChild(button);
            }
          }
        } catch (_) {}
      })();
    </script>`;

