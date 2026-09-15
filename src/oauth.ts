import { constantTimeEqual } from "./settings";

// Minimal env slice this module needs — deliberately not the full Worker Env (that
// lives in runtime/cycle.ts, which this file must not import to avoid a cycle).
export interface OAuthEnv {
  DB: D1Database;
  ADMIN_TOKEN: string;
  PLUGIN_SECRET_GOOGLE_CLIENT_ID?: string;
  PLUGIN_SECRET_GOOGLE_CLIENT_SECRET?: string;
}

export type OAuthErrorCode =
  | "oauth_not_configured"
  | "oauth_unsupported_provider"
  | "oauth_invalid_request"
  | "oauth_denied"
  | "oauth_state_invalid"
  | "oauth_exchange_failed"
  | "oauth_missing_refresh_token"
  | "oauth_not_connected"
  | "oauth_refresh_failed";

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface OAuthTokenRecord {
  pluginId: string;
  provider: string;
  refreshToken: string;
  accessToken: string | null;
  expiresAt: string | null;
  scope: string | null;
  updatedAt: string;
}

interface OAuthTokenRow {
  plugin_id: string;
  provider: string;
  refresh_token: string;
  access_token: string | null;
  expires_at: string | null;
  scope: string | null;
  updated_at: string;
}

export class D1OAuthTokenStore {
  constructor(private readonly db: D1Database) {}

  async get(pluginId: string): Promise<OAuthTokenRecord | null> {
    const row = await this.db.prepare("SELECT * FROM oauth_tokens WHERE plugin_id = ?").bind(pluginId).first<OAuthTokenRow>();
    return row ? fromRow(row) : null;
  }

  async has(pluginId: string): Promise<boolean> {
    return (await this.get(pluginId)) !== null;
  }

  async save(
    pluginId: string,
    provider: string,
    tokens: { refreshToken: string; accessToken?: string | null; expiresAt?: string | null; scope?: string | null },
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO oauth_tokens (plugin_id, provider, refresh_token, access_token, expires_at, scope, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (plugin_id) DO UPDATE SET
           provider = excluded.provider,
           refresh_token = excluded.refresh_token,
           access_token = excluded.access_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = excluded.updated_at`,
      )
      .bind(pluginId, provider, tokens.refreshToken, tokens.accessToken ?? null, tokens.expiresAt ?? null, tokens.scope ?? null, now)
      .run();
  }

  async updateAccessToken(pluginId: string, accessToken: string, expiresAt: string): Promise<void> {
    await this.db
      .prepare("UPDATE oauth_tokens SET access_token = ?, expires_at = ?, updated_at = ? WHERE plugin_id = ?")
      .bind(accessToken, expiresAt, new Date().toISOString(), pluginId)
      .run();
  }
}

function fromRow(row: OAuthTokenRow): OAuthTokenRecord {
  return {
    pluginId: row.plugin_id,
    provider: row.provider,
    refreshToken: row.refresh_token,
    accessToken: row.access_token,
    expiresAt: row.expires_at,
    scope: row.scope,
    updatedAt: row.updated_at,
  };
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// gmail.readonly is enough for the search_threads / get_thread ingest path (ADR-0033);
// widen this only if a future preset needs to write (drafts, labels).
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const STATE_VALIDITY_MS = 10 * 60 * 1000;
const STATE_CLOCK_SKEW_MS = 60 * 1000;
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;

function redirectUri(origin: string): string {
  return new URL("/settings/oauth/callback", origin).toString();
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return base64UrlEncodeBinary(binary);
}

function base64UrlEncodeText(text: string): string {
  return base64UrlEncodeBinary(text);
}

function base64UrlEncodeBinary(binary: string): string {
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeText(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (padded.length % 4)) % 4;
  return atob(padded + "=".repeat(padding));
}

// State is a signed, time-boxed token — never a secret itself, but forging one would
// let a request complete an OAuth callback for an arbitrary plugin id. HMAC-signed
// with ADMIN_TOKEN (already the Worker's one operator secret) rather than minting a
// dedicated key, matching ADR-0022 (no new secrets for internal wiring).
async function signState(pluginId: string, provider: string, secret: string): Promise<string> {
  const payload = base64UrlEncodeText(JSON.stringify({ pluginId, provider, ts: Date.now() }));
  const signature = await hmacSign(secret, payload);
  return `${payload}.${signature}`;
}

async function verifyState(state: string, secret: string): Promise<{ pluginId: string; provider: string } | null> {
  const separator = state.indexOf(".");
  if (separator === -1) {
    return null;
  }
  const payload = state.slice(0, separator);
  const signature = state.slice(separator + 1);
  const expected = await hmacSign(secret, payload);
  if (!constantTimeEqual(signature, expected)) {
    return null;
  }
  let decoded: { pluginId?: unknown; provider?: unknown; ts?: unknown };
  try {
    decoded = JSON.parse(base64UrlDecodeText(payload));
  } catch {
    return null;
  }
  if (typeof decoded.pluginId !== "string" || typeof decoded.provider !== "string" || typeof decoded.ts !== "number") {
    return null;
  }
  const age = Date.now() - decoded.ts;
  if (age > STATE_VALIDITY_MS || age < -STATE_CLOCK_SKEW_MS) {
    return null;
  }
  return { pluginId: decoded.pluginId, provider: decoded.provider };
}

/**
 * Builds the Google consent-screen URL to redirect the browser to. `access_type=offline`
 * plus `prompt=consent` asks Google for a refresh token on every run, not just the
 * first — the simplest way to recover from a revoked/lost one without extra state.
 */
export async function startAuthorization(pluginId: string, provider: "google", env: OAuthEnv, requestUrl: URL): Promise<string> {
  if (provider !== "google") {
    throw new OAuthError("oauth_unsupported_provider", `Unsupported OAuth provider: ${provider}.`);
  }
  const clientId = env.PLUGIN_SECRET_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new OAuthError("oauth_not_configured", "PLUGIN_SECRET_GOOGLE_CLIENT_ID is not configured.");
  }
  const state = await signState(pluginId, provider, env.ADMIN_TOKEN);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(requestUrl.origin),
    response_type: "code",
    scope: GMAIL_READONLY_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface OAuthCallbackResult {
  pluginId: string;
  provider: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Exchanges the authorization code for tokens and stores them. Never logs the code,
 * the tokens, or any response body — only stable error codes surface to callers.
 */
export async function handleCallback(url: URL, env: OAuthEnv, fetchImpl: typeof fetch = fetch): Promise<OAuthCallbackResult> {
  const providerError = url.searchParams.get("error");
  if (providerError) {
    throw new OAuthError("oauth_denied", "Google returned an OAuth error.");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new OAuthError("oauth_invalid_request", "Missing code or state.");
  }
  const verified = await verifyState(state, env.ADMIN_TOKEN);
  if (!verified) {
    throw new OAuthError("oauth_state_invalid", "OAuth state is invalid or expired.");
  }
  const clientId = env.PLUGIN_SECRET_GOOGLE_CLIENT_ID;
  const clientSecret = env.PLUGIN_SECRET_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new OAuthError("oauth_not_configured", "Google OAuth client secrets are not configured.");
  }
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(url.origin),
    grant_type: "authorization_code",
  });
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new OAuthError("oauth_exchange_failed", `Google token exchange returned HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as GoogleTokenResponse;
  const store = new D1OAuthTokenStore(env.DB);
  // Google only returns a refresh token on first consent (or when prompt=consent
  // forces re-consent); if this run didn't get one, keep whatever is on file.
  const refreshToken = payload.refresh_token ?? (await store.get(verified.pluginId))?.refreshToken;
  if (!refreshToken) {
    throw new OAuthError(
      "oauth_missing_refresh_token",
      "Google did not return a refresh token. Revoke unicorn's access in your Google account and reconnect.",
    );
  }
  const expiresAt = payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : null;
  await store.save(verified.pluginId, verified.provider, {
    refreshToken,
    accessToken: payload.access_token ?? null,
    expiresAt,
    scope: payload.scope ?? null,
  });
  return verified;
}

/**
 * Returns a valid access token for the plugin, refreshing it first if it is missing
 * or within 60s of expiry. Intended to be partially applied as the `OAuthTokenSource`
 * DeclarativePlugin's constructor accepts, e.g. `(pluginId) => getAccessToken(pluginId, env)`.
 */
export async function getAccessToken(pluginId: string, env: OAuthEnv, fetchImpl: typeof fetch = fetch): Promise<string> {
  const store = new D1OAuthTokenStore(env.DB);
  const row = await store.get(pluginId);
  if (!row) {
    throw new OAuthError("oauth_not_connected", `No OAuth token stored for plugin ${pluginId}.`);
  }
  const expiresAtMs = row.expiresAt ? Date.parse(row.expiresAt) : 0;
  if (row.accessToken && expiresAtMs - ACCESS_TOKEN_SKEW_MS > Date.now()) {
    return row.accessToken;
  }
  const clientId = env.PLUGIN_SECRET_GOOGLE_CLIENT_ID;
  const clientSecret = env.PLUGIN_SECRET_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new OAuthError("oauth_not_configured", "Google OAuth client secrets are not configured.");
  }
  const body = new URLSearchParams({
    refresh_token: row.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new OAuthError("oauth_refresh_failed", `Google token refresh returned HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as GoogleTokenResponse;
  if (!payload.access_token) {
    throw new OAuthError("oauth_refresh_failed", "Google token refresh did not return an access token.");
  }
  const expiresAt = new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString();
  await store.updateAccessToken(pluginId, payload.access_token, expiresAt);
  return payload.access_token;
}
