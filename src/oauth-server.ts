// The Worker as an OAuth 2.1 authorization server for the door (ADR-0035): lets claude.ai,
// Claude mobile, Cowork, Claude Code routines and ChatGPT add unicorn as a connector with a
// click. Built on @cloudflare/workers-oauth-provider, which implements the wire protocol
// (PKCE S256-only, dynamic client registration, token issuance/refresh/revocation, the RFC 9728
// protected-resource metadata and RFC 8414 authorization-server metadata) and the consent
// transaction's CSRF protection (a single-use handle bound to a `__Host-` cookie — see its
// `oauth-consent` module). This file owns only what that library doesn't: the consent page's
// HTML, wiring MCP_TOKEN as an accepted bearer alongside real OAuth tokens, and the "Connected
// apps" list on /settings.
//
// Not to be confused with src/oauth.ts, the Google OAuth *client* used for Gmail ingest
// (ADR-0033) — this module is the authorization *server* for the door.
import OAuthProvider, {
  AuthorizationError,
  getOAuthApi,
  type AuthRequest,
  type ClientInfo,
  type ClientRegistrationCallbackResult,
  type GrantSummary,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { escapeHtml, htmlResponse, renderPage } from "./ui";

// The library's own `describeConsent` (and `ConsentDescription` type) ship on its main branch
// but not yet on the 1.1.0 release this repo pins — so the handful of facts the consent page
// needs are worked out here instead, from `lookupClient()` and the parsed `AuthRequest`.
interface ConsentDescription {
  clientName: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  scope: string[];
}

function describeConsent(client: ClientInfo | null, request: AuthRequest): ConsentDescription {
  let redirectHost = request.redirectUri;
  try {
    redirectHost = new URL(request.redirectUri).hostname || request.redirectUri;
  } catch {
    // A native app's private-use URI (e.g. `com.example.app:/callback`) has no host; show it whole.
  }
  return {
    clientName: client?.clientName?.trim() ? client.clientName : request.clientId,
    redirectHost,
    redirectIsLoopback: isLoopbackHostname(redirectHost),
    scope: [...request.scope],
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host);
}

// Minimal env slice this module needs — deliberately not the full Worker Env (that lives in
// runtime/cycle.ts, which this file must not import: it would couple the OAuth server to every
// source plugin's bindings for no reason).
export interface OAuthServerEnv {
  DB: D1Database;
  ADMIN_TOKEN: string;
  MCP_TOKEN: string;
  OAUTH_KV: KVNamespace;
}

type FetchHandler<Env> = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

// The single-user identity every grant is issued to: unicorn has one operator, authenticated by
// ADMIN_TOKEN (via /authorize's Basic auth) or, for local dev, the MCP_TOKEN bearer directly.
export const DOOR_USER_ID = "unicorn";

export const DOOR_PATH = "/mcp";
const AUTHORIZE_PATH = "/authorize";
const TOKEN_PATH = "/oauth/token";
const REGISTRATION_PATH = "/register";

// One scope: the door is read-only on every source and only ever writes its own state
// (briefs, plans, corrections, labels) — there is nothing to scope down further.
export const OAUTH_SCOPE = "memory";
export const OAUTH_SCOPE_DESCRIPTION =
  "Read your unicorn memory and update its own state — never writes to Ed, Moodle, Canvas or Gmail.";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
// 30 days; the library rotates the refresh token on every use (not configurable off), so a
// stolen refresh token is only usable until the legitimate client's next refresh.
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// Dynamic client registration is unauthenticated by design (RFC 7591 — Claude and ChatGPT
// register themselves the first time a user adds the connector, before /authorize ever asks for
// ADMIN_TOKEN). That means anyone who finds the Worker URL can call /register too. Rather than
// require a pre-shared registration token — which would break the "add as a connector" flow
// DCR exists for — cap how many clients can be on file at once, so the worst an anonymous script
// can do is fill up to this many junk KV entries, not an unbounded amount.
export const MAX_REGISTERED_CLIENTS = 20;

function doorResource(origin: string): string {
  return new URL(DOOR_PATH, origin).toString();
}

// Same algorithm as settings.ts's constantTimeEqual, duplicated rather than imported: this
// module and settings.ts would otherwise import each other (index.ts gates /authorize and the
// revoke route with settings.ts's isBasicAuthorized before calling into here), and six lines of
// a well-understood loop is cheaper than a circular module dependency.
function timingSafeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * Builds the OAuthProvider for this Worker. `doorHandler` and `defaultHandler` are supplied by
 * index.ts, which owns routing; this function only wires the OAuth mechanics around them.
 *
 * The door route (`apiRoute`) is the only thing this provider gates. `/mcp/admin` must never be
 * reachable through it — the provider's own route matching treats any sub-path of `apiRoute` as
 * the same resource, so `/mcp/admin` would otherwise be swallowed by the `/mcp` door route. index.ts
 * enforces the exclusion by never calling `provider.fetch` for that one path in the first place.
 */
export function createOAuthProvider<Env extends OAuthServerEnv>(
  env: Env,
  origin: string,
  doorHandler: FetchHandler<Env>,
  defaultHandler: FetchHandler<Env>,
): OAuthProvider<Env> {
  const resource = doorResource(origin);
  const options: OAuthProviderOptions<Env> = {
    apiRoute: resource,
    apiHandler: { fetch: doorHandler },
    defaultHandler: { fetch: defaultHandler },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTRATION_PATH,
    scopesSupported: [OAUTH_SCOPE],
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    // `scopes_supported` here (not just the authorization server's `scopesSupported` above) is
    // what the 401 challenge on /mcp names and what RFC 9728 clients read as required — the
    // library does not accept an S256-downgrade knob for this, only for PKCE (`allowPlainPKCE`,
    // which this config never sets, so PKCE stays S256-only).
    resourceMetadata: { resource, resource_name: "unicorn", scopes_supported: [OAUTH_SCOPE] },
    // Local Claude Code / dev keeps using the static MCP_TOKEN bearer (ADR-0035): the provider
    // checks its own KV-issued tokens against the door route first, and only calls this when
    // that lookup misses, so a real OAuth token is never routed through here. Compared in
    // constant time so a response-timing oracle can't recover MCP_TOKEN byte by byte.
    resolveExternalToken: async ({ token, env: requestEnv }) => {
      if (!requestEnv.MCP_TOKEN || !timingSafeEqual(token, requestEnv.MCP_TOKEN)) {
        return null;
      }
      return { props: { subject: DOOR_USER_ID, via: "mcp_token" as const }, audience: resource };
    },
  };
  // Assigned after the literal so the callback's closure can call getOAuthApi(options, env) —
  // the same options object OAuthProvider itself will use — without a forward reference.
  options.clientRegistrationCallback = async (): Promise<ClientRegistrationCallbackResult | void> => {
    const clients = await getOAuthApi(options, env).listClients({ limit: MAX_REGISTERED_CLIENTS });
    if (clients.items.length >= MAX_REGISTERED_CLIENTS) {
      return {
        code: "invalid_client_metadata",
        description: `unicorn allows at most ${MAX_REGISTERED_CLIENTS} registered OAuth clients; revoke an unused one under Connected apps in /settings first.`,
        status: 400,
      };
    }
  };
  return new OAuthProvider(options);
}

// --- /authorize: the consent page ------------------------------------------------------------
//
// Gated by the caller with the same Basic auth as /settings (index.ts checks isBasicAuthorized
// before calling this) — for a single-user deployment, "signing in" to approve a connector is
// entering ADMIN_TOKEN. CSRF on the POST is the library's job: beginConsent()/approveConsent()
// bind the consent transaction to a single-use, `__Host-` cookie-bound handle (see
// oauth-consent.ts) — nothing here mints or checks a token of its own.

function renderConsentPage(consent: ConsentDescription, handle: string): string {
  const clientName = escapeHtml(consent.clientName);
  const redirectHost = escapeHtml(consent.redirectHost);
  const loopbackWarning = consent.redirectIsLoopback
    ? `<p class="notice error" role="alert">This connects to a local app on your device (${redirectHost}). Only approve if you started this connection yourself.</p>`
    : "";
  const body = `
    ${loopbackWarning}
    <section class="card" aria-labelledby="consent-title">
      <div class="card-head">
        <h2 id="consent-title">${clientName}</h2>
        <p class="card-sub">wants to connect to unicorn. Tokens will be sent to <code>${redirectHost}</code>.</p>
      </div>
      <div class="card-body">
        <ul class="rows">
          <li class="source"><span class="source-name">Access requested</span><span class="source-state">${escapeHtml(OAUTH_SCOPE_DESCRIPTION)}</span></li>
        </ul>
        <form method="post" action="${AUTHORIZE_PATH}">
          <input type="hidden" name="handle" value="${escapeHtml(handle)}">
          <div class="actions">
            <button type="submit" name="action" value="deny" class="button secondary">Deny</button>
            <button type="submit" name="action" value="approve">Approve</button>
          </div>
        </form>
      </div>
    </section>
    <style>.button.secondary{background:transparent;color:var(--ink);border:1px solid var(--border);margin-right:8px}.button.secondary:hover{background:var(--card)}</style>`;
  return renderPage({
    title: "unicorn — connect an app",
    active: "/settings",
    heading: "Connect an app",
    subtitle: `${clientName} is requesting access to your unicorn memory.`,
    body,
  });
}

function renderAuthorizeError(message: string): string {
  return renderPage({
    title: "unicorn — connect an app",
    active: "/settings",
    heading: "Couldn't start this connection",
    subtitle: "Ask the client to start the connection again.",
    body: `<p class="notice error" role="alert">${escapeHtml(message)}</p>`,
  });
}

// Merges the library's transaction/redirect headers (Set-Cookie, Cache-Control, and — on the
// consent page — the clickjacking headers) onto a Response built with our own page shell.
function withExtraHeaders(response: Response, extra: Headers): Response {
  const headers = new Headers(response.headers);
  for (const cookie of extra.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  headers.set("cache-control", "no-store");
  const frameOptions = extra.get("x-frame-options");
  if (frameOptions) {
    headers.set("x-frame-options", frameOptions);
  }
  return new Response(response.body, { status: response.status, headers });
}

function redirectResponse(location: string, extra: Headers): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of extra.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

/** GET renders the consent page; POST approves or denies it. Caller has already checked Basic auth. */
export async function handleAuthorize(request: Request, helpers: OAuthHelpers): Promise<Response> {
  if (request.method === "GET") {
    let authRequest;
    try {
      authRequest = await helpers.parseAuthRequest(request);
    } catch (error) {
      // Never redirect here: the request hasn't been validated against a registered client's
      // redirect URIs yet, so any redirect_uri in the query string is still attacker-controlled.
      console.error(JSON.stringify({ event: "oauth_authorize_invalid_request" }));
      return htmlResponse(
        renderAuthorizeError(error instanceof Error ? error.message : "Invalid authorization request."),
        400,
      );
    }
    const client = await helpers.lookupClient(authRequest.clientId);
    const consent = describeConsent(client, authRequest);
    const { handle, headers } = await helpers.beginConsent(authRequest);
    return withExtraHeaders(htmlResponse(renderConsentPage(consent, handle)), headers);
  }

  if (request.method === "POST") {
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      return new Response("Invalid request origin.", { status: 403 });
    }
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    try {
      if (form.get("action") === "deny") {
        const denied = await helpers.denyConsent(request, handle);
        return redirectResponse(denied.redirectTo, denied.headers);
      }
      const approved = await helpers.approveConsent(request, handle, { scope: [OAUTH_SCOPE] });
      const client = await helpers.lookupClient(approved.request.clientId);
      const clientName = client?.clientName?.trim() ? client.clientName : approved.request.clientId;
      const { redirectTo } = await helpers.completeAuthorization({
        request: approved.request,
        userId: DOOR_USER_ID,
        metadata: { clientName },
        scope: approved.request.scope,
        props: { subject: DOOR_USER_ID, via: "oauth" as const },
      });
      return redirectResponse(redirectTo, approved.headers);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return htmlResponse(renderAuthorizeError(error.message), 400);
      }
      throw error;
    }
  }

  return new Response("Method not allowed.", { status: 405, headers: { allow: "GET, POST" } });
}

// --- /settings: Connected apps ---------------------------------------------------------------

/** Revokes a grant. Caller has already checked Basic auth, method and the request's origin. */
export async function handleRevokeApp(request: Request, helpers: OAuthHelpers): Promise<Response> {
  const form = await request.formData();
  const grantId = String(form.get("grantId") ?? "");
  if (grantId) {
    await helpers.revokeGrant(grantId, DOOR_USER_ID);
  }
  return new Response(null, { status: 303, headers: { location: "/settings?revoked=1" } });
}

export async function listConnectedApps(helpers: OAuthHelpers): Promise<GrantSummary[]> {
  const grants = await helpers.listUserGrants(DOOR_USER_ID, { limit: MAX_REGISTERED_CLIENTS });
  return grants.items;
}

/** One-line hook for settings.ts's renderSettings, per the coordination note in the ADR. */
export function renderConnectedApps(grants: GrantSummary[]): string {
  const rows = grants.length
    ? grants
        .map((grant) => {
          const metadata = grant.metadata as { clientName?: unknown } | null | undefined;
          const name =
            typeof metadata?.clientName === "string" && metadata.clientName.trim() ? metadata.clientName : grant.clientId;
          const created = new Date(grant.createdAt * 1000).toISOString().slice(0, 10);
          return `<li class="source connected-app">
            <span class="source-name">${escapeHtml(name)}</span>
            <span class="source-state">Connected ${created}</span>
            <form method="post" action="/settings/oauth/apps/revoke">
              <input type="hidden" name="grantId" value="${escapeHtml(grant.id)}">
              <button type="submit" class="button secondary">Revoke</button>
            </form>
          </li>`;
        })
        .join("")
    : `<p class="hint">No connected apps yet. Add unicorn as a connector from claude.ai, ChatGPT or Cowork — see docs/CONNECTORS.md.</p>`;
  return `
    <section class="card" aria-labelledby="connected-apps-title">
      <div class="card-head"><h2 id="connected-apps-title">Connected apps</h2><p class="card-sub">OAuth clients that can read your unicorn memory through /mcp.</p></div>
      <div class="card-body"><ul class="rail rows">${rows}</ul></div>
    </section>
    <style>
      .connected-app{display:flex;align-items:center;gap:10px}
      .connected-app form{margin:0}
      .button.secondary{background:transparent;color:var(--ink);border:1px solid var(--border)}
      .button.secondary:hover{background:var(--bg)}
    </style>`;
}
