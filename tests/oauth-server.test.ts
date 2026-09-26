import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import {
  createOAuthProvider,
  handleAuthorize,
  handleRevokeApp,
  listConnectedApps,
  MAX_REGISTERED_CLIENTS,
  OAUTH_SCOPE,
  renderConnectedApps,
  type OAuthServerEnv,
} from "../src/oauth-server";

const ORIGIN = "https://unicorn.example";
const ADMIN_TOKEN = "admin-secret";
const MCP_TOKEN = "mcp-secret";

// A minimal fake KV backing the whole provider — an in-memory Map implementing exactly the
// get/put/delete/list surface @cloudflare/workers-oauth-provider issues against OAUTH_KV.
class FakeKV {
  private store = new Map<string, { value: string; metadata?: unknown; expiresAt?: number }>();

  async get(key: string, options?: { type?: string } | string): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number; metadata?: unknown },
  ): Promise<void> {
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : options?.expiration
        ? options.expiration * 1000
        : undefined;
    this.store.set(key, { value, metadata: options?.metadata, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }> {
    const prefix = options?.prefix ?? "";
    const now = Date.now();
    const names = [...this.store.entries()]
      .filter(([key, entry]) => key.startsWith(prefix) && !(entry.expiresAt !== undefined && entry.expiresAt <= now))
      .map(([name, entry]) => ({ name, metadata: entry.metadata }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const limit = options?.limit ?? 1000;
    const start = options?.cursor ? Number(options.cursor) : 0;
    const page = names.slice(start, start + limit);
    const complete = start + limit >= names.length;
    return { keys: page, list_complete: complete, cursor: complete ? undefined : String(start + limit) };
  }
}

function testEnv(overrides: Partial<OAuthServerEnv> = {}): OAuthServerEnv {
  return {
    DB: {} as unknown as D1Database,
    ADMIN_TOKEN,
    MCP_TOKEN,
    OAUTH_KV: new FakeKV() as unknown as KVNamespace,
    ...overrides,
  };
}

function ctx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

function basicAuth(token: string): string {
  return `Basic ${btoa(`unicorn:${token}`)}`;
}

function isBasicAuthorized(header: string | null, token: string): boolean {
  if (!header?.startsWith("Basic ") || !token) return false;
  const decoded = atob(header.slice(6));
  const separator = decoded.indexOf(":");
  return separator !== -1 && decoded.slice(0, separator) === "unicorn" && decoded.slice(separator + 1) === token;
}

async function doorStub(request: Request): Promise<Response> {
  return Response.json({ ok: true, method: request.method });
}

// Mirrors what index.ts's defaultFetch does: gates /authorize and the revoke route with the
// same Basic auth as /settings, then hands off to oauth-server.ts. Kept in the test file (not
// imported from src/index.ts) so this suite exercises the public API of *this* module only.
async function defaultStub(request: Request, env: OAuthServerEnv): Promise<Response> {
  const url = new URL(request.url);
  const helpers = (env as unknown as { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;

  if (url.pathname === "/authorize") {
    if (!isBasicAuthorized(request.headers.get("authorization"), env.ADMIN_TOKEN)) {
      return new Response("Authentication required.", { status: 401, headers: { "www-authenticate": "Basic" } });
    }
    return handleAuthorize(request, helpers);
  }

  if (url.pathname === "/settings/oauth/apps/revoke" && request.method === "POST") {
    if (!isBasicAuthorized(request.headers.get("authorization"), env.ADMIN_TOKEN)) {
      return new Response("Authentication required.", { status: 401 });
    }
    if (request.headers.get("origin") !== url.origin) {
      return new Response("Invalid request origin.", { status: 403 });
    }
    return handleRevokeApp(request, helpers);
  }

  if (url.pathname === "/settings") {
    const grants = await listConnectedApps(helpers);
    return new Response(renderConnectedApps(grants), { headers: { "content-type": "text/html" } });
  }

  if (url.pathname === "/mcp/admin") {
    if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return Response.json({ ok: true, admin: true });
  }

  return new Response("not found", { status: 404 });
}

function buildProvider(env: OAuthServerEnv) {
  return createOAuthProvider(env, ORIGIN, doorStub, defaultStub);
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}

function extractHandle(html: string): string {
  const match = /name="handle" value="([^"]+)"/.exec(html);
  if (!match) throw new Error("no consent handle found in HTML");
  return match[1];
}

function extractGrantId(html: string): string {
  const match = /name="grantId" value="([^"]+)"/.exec(html);
  if (!match) throw new Error("no grantId found in HTML");
  return match[1];
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** Registers a public client and drives the full code+PKCE flow through to an access token. */
async function authorizeAndIssueToken(
  env: OAuthServerEnv,
  options: { scope?: string; deny?: boolean } = {},
): Promise<{ accessToken?: string; refreshToken?: string; redirect?: URL; clientId: string; redirectUri: string }> {
  const provider = buildProvider(env);
  const redirectUri = "https://client.example/callback";

  const registered = await provider.fetch(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: "Test Client",
        token_endpoint_auth_method: "none",
      }),
    }),
    env,
    ctx(),
  );
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { client_id: string };

  const { verifier, challenge } = await pkcePair();
  const authorizeUrl = new URL(`${ORIGIN}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", options.scope ?? OAUTH_SCOPE);
  authorizeUrl.searchParams.set("state", "xyz");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const consentPage = await provider.fetch(
    new Request(authorizeUrl, { headers: { authorization: basicAuth(ADMIN_TOKEN) } }),
    env,
    ctx(),
  );
  expect(consentPage.status).toBe(200);
  const html = await consentPage.text();
  const handle = extractHandle(html);
  const cookie = cookieHeader(consentPage);

  const approveForm = new URLSearchParams({ handle, action: options.deny ? "deny" : "approve" });
  const approveResponse = await provider.fetch(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: {
        authorization: basicAuth(ADMIN_TOKEN),
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        cookie,
      },
      body: approveForm,
    }),
    env,
    ctx(),
  );
  expect(approveResponse.status).toBe(302);
  const redirect = new URL(approveResponse.headers.get("location")!);

  if (options.deny) {
    return { redirect, clientId: client.client_id, redirectUri };
  }

  const code = redirect.searchParams.get("code")!;
  const tokenResponse = await provider.fetch(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
      }),
    }),
    env,
    ctx(),
  );
  expect(tokenResponse.status).toBe(200);
  const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token?: string };
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, redirect, clientId: client.client_id, redirectUri };
}

describe("oauth-server metadata", () => {
  it("publishes RFC 8414 authorization server metadata", async () => {
    const env = testEnv();
    const provider = buildProvider(env);

    const response = await provider.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env, ctx());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(body.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.scopes_supported).toEqual([OAUTH_SCOPE]);
  });

  it("publishes RFC 9728 protected resource metadata for /mcp", async () => {
    const env = testEnv();
    const provider = buildProvider(env);

    // The library nests a resource's metadata under its own path within the well-known
    // namespace (RFC 9728 §3.1 multi-resource form) since the resource here is "<origin>/mcp",
    // not the bare origin.
    const response = await provider.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`), env, ctx());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.resource).toBe(`${ORIGIN}/mcp`);
    expect(body.scopes_supported).toEqual([OAUTH_SCOPE]);
    expect(body.authorization_servers).toEqual([ORIGIN]);
  });
});

describe("dynamic client registration", () => {
  it("registers a client and returns a client_id", async () => {
    const env = testEnv();
    const provider = buildProvider(env);

    const response = await provider.fetch(
      new Request(`${ORIGIN}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://client.example/callback"] }),
      }),
      env,
      ctx(),
    );
    const body = (await response.json()) as { client_id?: string };

    expect(response.status).toBe(201);
    expect(body.client_id).toBeTruthy();
  });

  it("caps the number of registered clients so anonymous DCR can't fill OAUTH_KV unbounded", async () => {
    const env = testEnv();
    const provider = buildProvider(env);
    const register = () =>
      provider.fetch(
        new Request(`${ORIGIN}/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect_uris: ["https://client.example/callback"] }),
        }),
        env,
        ctx(),
      );

    for (let index = 0; index < MAX_REGISTERED_CLIENTS; index += 1) {
      const response = await register();
      expect(response.status).toBe(201);
    }

    const rejected = await register();
    expect(rejected.status).toBe(400);
    const body = (await rejected.json()) as { error?: string };
    expect(body.error).toBe("invalid_client_metadata");
  });
});

describe("the door route (/mcp)", () => {
  it("accepts the static MCP_TOKEN bearer", async () => {
    const env = testEnv();
    const provider = buildProvider(env);

    const response = await provider.fetch(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${MCP_TOKEN}` } }),
      env,
      ctx(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, method: "POST" });
  });

  it("accepts a real OAuth access token from the code+PKCE flow", async () => {
    const env = testEnv();
    const { accessToken } = await authorizeAndIssueToken(env);

    const response = await provider_fetch(env, `${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
  });

  it("rejects a garbage bearer with 401 and a WWW-Authenticate pointing at protected-resource metadata", async () => {
    const env = testEnv();
    const response = await provider_fetch(env, `${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer garbage" },
    });

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain("/.well-known/oauth-protected-resource");
  });

  it("rejects a request with no Authorization header at all", async () => {
    const env = testEnv();
    const response = await provider_fetch(env, `${ORIGIN}/mcp`, { method: "POST" });
    expect(response.status).toBe(401);
  });
});

// The OAuthProvider's own apiRoute matching treats any sub-path of the door's "/mcp" apiRoute as
// the same protected resource (it's built for REST-style resource hierarchies, where that's the
// right default) — so "/mcp/admin" would otherwise be swallowed by the door route. index.ts's
// default export defends against this structurally, by never calling provider.fetch for that one
// path at all. topLevelFetch reproduces that one-line routing decision so this suite tests the
// composed behavior a real request actually gets, not just what oauth-server.ts alone can promise.
async function topLevelFetch(env: OAuthServerEnv, url: string, init?: RequestInit): Promise<Response> {
  const request = new Request(url, init);
  if (new URL(url).pathname === "/mcp/admin") {
    return defaultStub(request, env);
  }
  return provider_fetch(env, url, init);
}

describe("/mcp/admin never accepts an OAuth token", () => {
  it("rejects an OAuth access token issued for the door", async () => {
    const env = testEnv();
    const { accessToken } = await authorizeAndIssueToken(env);

    const response = await topLevelFetch(env, `${ORIGIN}/mcp/admin`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(401);
  });

  it("still accepts the ADMIN_TOKEN bearer", async () => {
    const env = testEnv();
    const response = await topLevelFetch(env, `${ORIGIN}/mcp/admin`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  it("regression guard: the raw OAuthProvider would otherwise route /mcp/admin into the door apiRoute", async () => {
    // Documents *why* index.ts must bypass provider.fetch for this path (see topLevelFetch above)
    // — if @cloudflare/workers-oauth-provider ever changes its route matching to be exact rather
    // than prefix-based, this test starts failing and the bypass in index.ts can be removed.
    const env = testEnv();
    const response = await provider_fetch(env, `${ORIGIN}/mcp/admin`, {
      method: "POST",
      headers: { authorization: `Bearer ${MCP_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, method: "POST" });
  });
});

describe("/authorize consent", () => {
  it("requires Basic auth", async () => {
    const env = testEnv();
    const response = await provider_fetch(env, `${ORIGIN}/authorize?response_type=code&client_id=x&redirect_uri=https://client.example/callback&scope=memory`);
    expect(response.status).toBe(401);
  });

  it("never redirects an unregistered client_id or redirect_uri", async () => {
    const env = testEnv();
    const response = await provider_fetch(
      env,
      `${ORIGIN}/authorize?response_type=code&client_id=nope&redirect_uri=https://evil.example/steal&scope=memory`,
      { headers: { authorization: basicAuth(ADMIN_TOKEN) } },
    );
    // Must render an error page (400), never a redirect to the attacker-controlled URL.
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("enforces CSRF: approving with no binding cookie fails", async () => {
    const env = testEnv();
    const provider = buildProvider(env);
    const registered = await provider.fetch(
      new Request(`${ORIGIN}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }),
      }),
      env,
      ctx(),
    );
    const client = (await registered.json()) as { client_id: string };
    const { challenge } = await pkcePair();
    const authorizeUrl = `${ORIGIN}/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=https://client.example/callback&scope=memory&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`;
    const consentPage = await provider.fetch(
      new Request(authorizeUrl, { headers: { authorization: basicAuth(ADMIN_TOKEN) } }),
      env,
      ctx(),
    );
    const handle = extractHandle(await consentPage.text());
    // No cookie sent — a forged cross-site POST would look exactly like this.
    const forged = await provider.fetch(
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: { authorization: basicAuth(ADMIN_TOKEN), "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: new URLSearchParams({ handle, action: "approve" }),
      }),
      env,
      ctx(),
    );
    expect(forged.status).toBe(400);
  });

  it("rejects a cross-origin POST", async () => {
    const env = testEnv();
    const response = await provider_fetch(env, `${ORIGIN}/authorize`, {
      method: "POST",
      headers: { authorization: basicAuth(ADMIN_TOKEN), "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: "handle=whatever&action=approve",
    });
    expect(response.status).toBe(403);
  });

  it("denying redirects with error=access_denied and the original state", async () => {
    const env = testEnv();
    const { redirect } = await authorizeAndIssueToken(env, { deny: true });
    expect(redirect?.searchParams.get("error")).toBe("access_denied");
    expect(redirect?.searchParams.get("state")).toBe("xyz");
  });
});

describe("/settings connected apps", () => {
  it("lists a connected app after approval and lets it be revoked", async () => {
    const env = testEnv();
    await authorizeAndIssueToken(env);

    const settingsPage = await provider_fetch(env, `${ORIGIN}/settings`);
    const html = await settingsPage.text();
    expect(html).toContain("Test Client");

    const grantId = extractGrantId(html);
    const revoke = await provider_fetch(env, `${ORIGIN}/settings/oauth/apps/revoke`, {
      method: "POST",
      headers: { authorization: basicAuth(ADMIN_TOKEN), "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: `grantId=${encodeURIComponent(grantId)}`,
    });
    expect(revoke.status).toBe(303);

    const after = await provider_fetch(env, `${ORIGIN}/settings`);
    expect(await after.text()).not.toContain("Test Client");
  });

  it("requires Basic auth to revoke", async () => {
    const env = testEnv();
    const response = await provider_fetch(env, `${ORIGIN}/settings/oauth/apps/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: "grantId=whatever",
    });
    expect(response.status).toBe(401);
  });

  it("rejects a cross-origin revoke (CSRF)", async () => {
    const env = testEnv();
    const response = await provider_fetch(env, `${ORIGIN}/settings/oauth/apps/revoke`, {
      method: "POST",
      headers: { authorization: basicAuth(ADMIN_TOKEN), "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: "grantId=whatever",
    });
    expect(response.status).toBe(403);
  });
});

// Small helper so most tests don't need to repeat `buildProvider(env).fetch(new Request(...), env, ctx())`.
async function provider_fetch(env: OAuthServerEnv, url: string, init?: RequestInit): Promise<Response> {
  return buildProvider(env).fetch(new Request(url, init), env, ctx());
}
