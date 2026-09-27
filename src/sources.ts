// Source registry + credentials (ADR-0038 onboarding by source).
//
// A preset is data, not code: id, label, the fields /settings collects, and how
// to get a token. Deviation from ADR-0038's "stored as PLUGIN_SECRET_*": the
// Worker cannot mutate its own Worker Secrets (ADR-0022), so a token pasted into
// /settings has nowhere else to live — it is encrypted application state in D1
// (`source_credentials`, migration 0014), never plaintext, never rendered back,
// never logged. A Worker Secret set the ops way (`wrangler secret put`) always
// wins over anything pasted, so an existing production deploy is untouched.

import { CanvasPlugin, type CanvasPluginOptions } from "./plugins/campus/canvas-plugin";
import { EdPlugin, type EdPluginOptions, type EdRegion } from "./plugins/campus/ed-plugin";
import { MoodlePlugin, type MoodlePluginOptions } from "./plugins/campus/moodle-plugin";
import type { Plugin } from "./plugins/plugin";

export type SourceId = "ed" | "moodle" | "canvas" | "gmail";

export const SOURCE_IDS: SourceId[] = ["ed", "moodle", "canvas", "gmail"];

// The plugin id each source registers items under (kernel/items.source), used to
// join source status against last_cycle results and item counts.
export const PLUGIN_ID: Record<SourceId, string> = {
  ed: "campus-ed",
  moodle: "campus-moodle",
  canvas: "campus-canvas",
  gmail: "gmail",
};

export type FieldType = "text" | "password" | "select";

export interface SourceField {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  options?: readonly string[]; // required for type "select"
}

export interface SourcePreset {
  id: SourceId;
  label: string;
  fields: SourceField[];
  // One sentence: how to get a credential, plus the official page to get it from.
  instructions: string;
  instructionsUrl: string;
}

export const SOURCE_PRESETS: SourcePreset[] = [
  {
    id: "ed",
    label: "Ed Discussion",
    fields: [
      { key: "token", label: "API token", type: "password" },
      { key: "region", label: "Region", type: "select", options: ["us", "au", "eu"] },
    ],
    instructions: "Generate a token on Ed's API tokens page, then paste it below.",
    instructionsUrl: "https://edstem.org/us/settings/api-tokens",
  },
  {
    id: "moodle",
    label: "Moodle",
    fields: [
      { key: "baseUrl", label: "Base URL", type: "text", placeholder: "https://learning.monash.edu" },
      { key: "session", label: "Session cookie (advanced)", type: "password" },
    ],
    instructions: "Run `npm run moodle:push` from your machine to push a fresh session; paste one below only if you can't run that locally.",
    instructionsUrl: "https://github.com/TuuHub/unicorn/blob/main/SETUP.md",
  },
  {
    id: "canvas",
    label: "Canvas",
    fields: [
      { key: "baseUrl", label: "Base URL", type: "text", placeholder: "https://school.instructure.com" },
      { key: "token", label: "Personal access token", type: "password" },
    ],
    instructions: "Create a personal access token from Account -> Settings -> New access token in Canvas.",
    instructionsUrl: "https://canvas.instructure.com/doc/api/file.oauth.html#manual-token-generation",
  },
  {
    id: "gmail",
    label: "Gmail",
    fields: [], // Google OAuth Connect flow (src/oauth.ts) — nothing pasted here.
    instructions: "Set the Google OAuth client secrets with wrangler, then use Connect Gmail below.",
    instructionsUrl: "https://console.cloud.google.com/apis/credentials",
  },
];

export function presetFor(id: SourceId): SourcePreset {
  const preset = SOURCE_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) {
    throw new Error(`Unknown source id: ${id}`);
  }
  return preset;
}

export function isSourceId(value: string): value is SourceId {
  return (SOURCE_IDS as string[]).includes(value);
}

// --- Encryption --------------------------------------------------------------
//
// AES-256-GCM; the key is derived from ADMIN_TOKEN via HKDF-SHA256 (WebCrypto),
// never stored anywhere itself. Salt and info are fixed, documented constants —
// they don't need to be secret (HKDF's security comes from the input key
// material), they just need to be stable so re-deriving the key always produces
// the same bytes. A random 12-byte IV is drawn per value and stored alongside
// the ciphertext (both base64), per the standard AES-GCM nonce-reuse rule.
const HKDF_SALT = new TextEncoder().encode("unicorn/source-credentials/v1/salt");
const HKDF_INFO = new TextEncoder().encode("unicorn/source-credentials/v1/aes-256-gcm");
const IV_BYTES = 12;

async function deriveKey(adminToken: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(adminToken), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export interface EncryptedValue {
  ciphertext: string; // base64
  iv: string; // base64
}

export async function encryptFields(fields: Record<string, string>, adminToken: string): Promise<EncryptedValue> {
  const key = await deriveKey(adminToken);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(fields));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { ciphertext: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}

// Returns null on any failure (wrong key after ADMIN_TOKEN rotation, corrupted
// row, tampered ciphertext) — callers treat that exactly like "not configured"
// plus a "re-enter token" hint. Never throws: a bad credential row must never
// crash the sync cycle.
export async function decryptFields(value: EncryptedValue, adminToken: string): Promise<Record<string, string> | null> {
  try {
    const key = await deriveKey(adminToken);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(value.iv) }, key, fromBase64(value.ciphertext));
    const parsed = JSON.parse(new TextDecoder().decode(decrypted));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

// --- Credential store ----------------------------------------------------------

export type CredentialLookup =
  | { status: "none" }
  | { status: "ok"; fields: Record<string, string> }
  | { status: "invalid" }; // a row exists but no longer decrypts (ADMIN_TOKEN rotated)

export interface SourceCredentialStore {
  get(sourceId: SourceId): Promise<CredentialLookup>;
  save(sourceId: SourceId, fields: Record<string, string>): Promise<void>;
  delete(sourceId: SourceId): Promise<void>;
}

interface CredentialRow {
  ciphertext: string;
  iv: string;
}

export class D1SourceCredentialStore implements SourceCredentialStore {
  constructor(
    private readonly db: D1Database,
    private readonly adminToken: string,
  ) {}

  async get(sourceId: SourceId): Promise<CredentialLookup> {
    const row = await this.db
      .prepare("SELECT ciphertext, iv FROM source_credentials WHERE source_id = ?")
      .bind(sourceId)
      .first<CredentialRow>();
    if (!row) {
      return { status: "none" };
    }
    const fields = await decryptFields(row, this.adminToken);
    return fields ? { status: "ok", fields } : { status: "invalid" };
  }

  async save(sourceId: SourceId, fields: Record<string, string>): Promise<void> {
    const encrypted = await encryptFields(fields, this.adminToken);
    await this.db
      .prepare(
        `INSERT INTO source_credentials (source_id, ciphertext, iv, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (source_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, updated_at = excluded.updated_at`,
      )
      .bind(sourceId, encrypted.ciphertext, encrypted.iv, new Date().toISOString())
      .run();
  }

  async delete(sourceId: SourceId): Promise<void> {
    await this.db.prepare("DELETE FROM source_credentials WHERE source_id = ?").bind(sourceId).run();
  }
}

function fieldsOf(lookup: CredentialLookup): Record<string, string> | undefined {
  return lookup.status === "ok" ? lookup.fields : undefined;
}

// --- Env / D1 precedence -------------------------------------------------------
//
// Env slice this module needs. A plain object (not the full Worker Env) so tests
// don't have to fake bindings this module never touches.
export interface SourceEnv {
  ED_API_TOKEN?: string;
  MOODLE_BASE_URL: string;
  MOODLE_SESSION?: string;
  CANVAS_BASE_URL?: string;
  PLUGIN_SECRET_CANVAS_TOKEN?: string;
}

// Secret precedence: a Worker Secret set the ops way always wins over a value
// pasted into /settings, so an existing deploy that already has ED_API_TOKEN /
// MOODLE_SESSION / PLUGIN_SECRET_CANVAS_TOKEN / CANVAS_BASE_URL set is completely
// untouched by this feature.
function secretWins(envValue: string | undefined, stored: string | undefined): string | undefined {
  return envValue && envValue.length > 0 ? envValue : stored || undefined;
}

// Base-URL precedence for Moodle only: MOODLE_BASE_URL is a plain `vars` default
// checked into wrangler.jsonc for the one school this repo ships configured for,
// not an operator secret — a student at a different institution has no other way
// to point unicorn at their own Moodle without a redeploy, so a value saved in
// /settings overrides the shipped default. (Canvas has no shipped default, and
// CANVAS_BASE_URL is treated as a secret-grade override above like the ADR lists it.)
function configWins(stored: string | undefined, envValue: string): string {
  return stored && stored.length > 0 ? stored : envValue;
}

export function resolveEdCredentials(env: SourceEnv, lookup: CredentialLookup): EdPluginOptions | null {
  const stored = fieldsOf(lookup);
  const token = secretWins(env.ED_API_TOKEN, stored?.token);
  if (!token) {
    return null;
  }
  const region = (stored?.region as EdRegion | undefined) ?? "us";
  return { token, region };
}

export function resolveMoodleCredentials(env: SourceEnv, lookup: CredentialLookup): MoodlePluginOptions | null {
  const stored = fieldsOf(lookup);
  const session = secretWins(env.MOODLE_SESSION, stored?.session);
  if (!session) {
    return null;
  }
  return { baseUrl: configWins(stored?.baseUrl, env.MOODLE_BASE_URL), session };
}

export function resolveCanvasCredentials(env: SourceEnv, lookup: CredentialLookup): CanvasPluginOptions | null {
  const stored = fieldsOf(lookup);
  const token = secretWins(env.PLUGIN_SECRET_CANVAS_TOKEN, stored?.token);
  const baseUrl = secretWins(env.CANVAS_BASE_URL, stored?.baseUrl);
  if (!token || !baseUrl) {
    return null;
  }
  return { baseUrl, token };
}

// Non-secret field values only, for prefilling the /settings form — password
// fields never round-trip (see resolve*Credentials for the full, secret-including
// resolution used to actually build a plugin).
export function nonSecretPrefill(id: SourceId, env: SourceEnv, lookup: CredentialLookup): Record<string, string> {
  const stored = fieldsOf(lookup);
  if (id === "ed") {
    return { region: stored?.region ?? "us" };
  }
  if (id === "moodle") {
    return { baseUrl: configWins(stored?.baseUrl, env.MOODLE_BASE_URL) };
  }
  if (id === "canvas") {
    return { baseUrl: secretWins(env.CANVAS_BASE_URL, stored?.baseUrl) ?? "" };
  }
  return {};
}

// --- Plugin construction --------------------------------------------------------

async function buildPlugin(id: SourceId, env: SourceEnv, credentials: SourceCredentialStore): Promise<Plugin | null> {
  if (id === "ed") {
    const options = resolveEdCredentials(env, await credentials.get("ed"));
    return options ? new EdPlugin(options) : null;
  }
  if (id === "moodle") {
    const options = resolveMoodleCredentials(env, await credentials.get("moodle"));
    return options ? new MoodlePlugin(options) : null;
  }
  if (id === "canvas") {
    const options = resolveCanvasCredentials(env, await credentials.get("canvas"));
    return options ? new CanvasPlugin(options) : null;
  }
  return null; // gmail is a declarative-plugin manifest, built by runtime/cycle.ts.
}

// Builds every configured campus plugin (Ed, Moodle, Canvas) from env-or-D1
// credentials, skipping any source with nothing configured on either side.
// Gmail is not included: it is a manifest-driven DeclarativePlugin installed by
// the OAuth connect flow, assembled by runtime/cycle.ts alongside the others.
export async function buildSourcePlugins(env: SourceEnv, credentials: SourceCredentialStore): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const id of (["ed", "moodle", "canvas"] as const)) {
    const plugin = await buildPlugin(id, env, credentials);
    if (plugin) {
      plugins.push(plugin);
    }
  }
  return plugins;
}

export type SourceTestResult = { ok: true; count: number } | { ok: false; error: string };

// Runs a source's pull() without ingesting anything — no kernel, no D1 item
// writes — purely to answer "does this credential work right now?" for the
// Test connection button.
export async function testSource(id: SourceId, env: SourceEnv, credentials: SourceCredentialStore): Promise<SourceTestResult> {
  if (id === "gmail") {
    return { ok: false, error: "Gmail is tested by reconnecting — use Connect Gmail." };
  }
  const plugin = await buildPlugin(id, env, credentials);
  if (!plugin) {
    return { ok: false, error: "Not configured yet — save a credential first." };
  }
  try {
    const items = await plugin.pull();
    return { ok: true, count: items.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- Status view for /settings --------------------------------------------------

export interface SourceStatusRow {
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface SourceStatus {
  id: SourceId;
  label: string;
  configured: boolean;
  needsReentry: boolean; // a credential row exists but no longer decrypts
  lastSyncAt: string | null;
  lastError: string | null;
  items: number;
}

// Active item counts per plugin id, for the Sources cards. One query, grouped —
// not N+1 per source.
export async function itemCountsByPlugin(db: D1Database): Promise<Record<string, number>> {
  const rows = await db
    .prepare("SELECT source, COUNT(*) AS count FROM items WHERE archived_at IS NULL GROUP BY source")
    .all<{ source: string; count: number }>();
  return Object.fromEntries(rows.results.map((row) => [row.source, row.count]));
}

export async function buildSourceStatuses(
  env: SourceEnv,
  credentials: SourceCredentialStore,
  lastCycleByPlugin: Record<string, SourceStatusRow>,
  itemCounts: Record<string, number>,
  gmailConfigured: boolean,
): Promise<SourceStatus[]> {
  const statuses: SourceStatus[] = [];
  for (const preset of SOURCE_PRESETS) {
    const lookup = preset.id === "gmail" ? { status: "none" as const } : await credentials.get(preset.id);
    const plugin = preset.id === "gmail" ? null : await buildPlugin(preset.id, env, credentials);
    const pluginId = PLUGIN_ID[preset.id];
    const cycleRow = lastCycleByPlugin[pluginId];
    statuses.push({
      id: preset.id,
      label: preset.label,
      configured: preset.id === "gmail" ? gmailConfigured : plugin !== null,
      needsReentry: lookup.status === "invalid",
      lastSyncAt: cycleRow?.lastSyncAt ?? null,
      lastError: cycleRow?.lastError ?? null,
      items: itemCounts[pluginId] ?? 0,
    });
  }
  return statuses;
}
