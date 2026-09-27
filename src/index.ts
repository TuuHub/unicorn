import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { D1BriefStore } from "./briefs";
import { D1MemoryStore } from "./memory";
import { D1McpRepository } from "./mcp/d1-repository";
import { createDoorMcpServer } from "./mcp/door";
import { D1DoorRepository } from "./mcp/door-repository";
import { createAdminMcpServer } from "./mcp/server";
import { MoodleProbeError, probeMoodle } from "./moodle-probe";
import { D1OAuthTokenStore, handleCallback, OAuthError, startAuthorization, type OAuthEnv } from "./oauth";
import { createOAuthProvider, handleAuthorize, handleRevokeApp, listConnectedApps } from "./oauth-server";
import { D1ManifestStore } from "./plugins/declarative/store";
import gmailPreset from "./plugins/presets/gmail.json";
import { runCycle, Scheduler, type CycleResult, type Env } from "./runtime/cycle";
import { constantTimeEqual, D1SettingsRepository, handleSettings, isBasicAuthorized, type LastCycleInfo } from "./settings";
import { D1SourceCredentialStore, itemCountsByPlugin } from "./sources";

export { Scheduler };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

// Live operational state shared by /health and /settings: is the hourly
// scheduler alarm set? Best-effort — a failure reports as degraded rather
// than throwing.
async function operationalStatus(env: Env): Promise<{ schedulerRunning: boolean }> {
  try {
    const id = env.SCHEDULER.idFromName("primary");
    const response = await env.SCHEDULER.get(id).fetch(new Request("https://scheduler/status"));
    const body = (await response.json()) as { scheduled?: boolean };
    return { schedulerRunning: body.scheduled === true };
  } catch {
    return { schedulerRunning: false };
  }
}

// Reads the compact cycle summary runtime/cycle.ts's recordCycle() writes, for
// /settings' Deployment health card and per-source last sync/error. Best-effort:
// a missing or unparseable row (first run, or a shape from before this feature)
// just means "never run" rather than a 500.
async function loadLastCycle(db: D1Database): Promise<LastCycleInfo> {
  try {
    const row = await db.prepare("SELECT value_json FROM settings WHERE key = 'last_cycle'").first<{ value_json: string }>();
    if (!row) {
      return { at: null, byPlugin: {} };
    }
    const cycle = JSON.parse(row.value_json) as CycleResult;
    const byPlugin = Object.fromEntries(
      (cycle.sources ?? []).map((source) => [source.plugin, { lastSyncAt: source.lastSyncAt, lastError: source.lastError }]),
    );
    return { at: cycle.at ?? null, byPlugin };
  } catch {
    return { at: null, byPlugin: {} };
  }
}

// Bearer routes compare against the secret in constant time so a response-timing
// oracle cannot recover the token byte by byte.
function bearerOk(request: Request, token: string | undefined): boolean {
  const header = request.headers.get("authorization");
  if (!token || !header?.startsWith("Bearer ")) {
    return false;
  }
  return constantTimeEqual(header.slice(7), token);
}

function requireBasicAuth(request: Request, adminToken: string): Response | null {
  if (isBasicAuthorized(request.headers.get("authorization"), adminToken)) {
    return null;
  }
  return new Response("Authentication required.", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="unicorn settings", charset="UTF-8"' },
  });
}

// The door (ADR-0030/0034/0035): a memory-layer tool set for a client agent. Reachable with
// either the static MCP_TOKEN bearer or an OAuth access token /authorize issued — both are
// authenticated by the OAuthProvider wrapping this Worker (see oauth-server.ts) before this
// function ever runs, so it never re-checks a bearer itself. Extracted to a named function
// (rather than inlined where /mcp used to be routed) so the door agent's own edits to this
// handler's body stay isolated from the OAuth wiring around it.
async function handleDoor(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "POST" },
    });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });
  const server = await createDoorMcpServer({
    briefs: new D1BriefStore(env.DB),
    memory: new D1MemoryStore(env.DB),
    repo: new D1DoorRepository(env.DB),
    settings: new D1SettingsRepository(env.DB),
    schedulerStatus: async () => ({ running: (await operationalStatus(env)).schedulerRunning }),
    db: env.DB,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

// Everything that is not the door's API route. The OAuthProvider (oauth-server.ts) calls this
// for every request that isn't `/mcp`, including the endpoints it implements no special
// handling for (`/settings`, `/mcp/admin`, `/health`, …) and the ones ADR-0035 adds
// (`/authorize`, the "Connected apps" revoke action). `env.OAUTH_PROVIDER` is injected by the
// provider for the lifetime of this call. Crucially, `/mcp/admin` is never the door's API route,
// so an OAuth access token is never checked against it — it stays bearer-ADMIN_TOKEN-only by
// construction, not by a check here that could be forgotten.
async function defaultFetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const oauthHelpers = (env as unknown as { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;

  if (request.method === "GET" && url.pathname === "/") {
    // A fresh deployer opening the bare workers.dev URL should land somewhere
    // useful, not on a JSON 404. /settings is the human surface.
    return Response.redirect(new URL("/settings", url).toString(), 302);
  }

  if (request.method === "GET" && url.pathname === "/health") {
    // A real readiness check: verify D1 answers and report whether the hourly
    // scheduler is armed, so the post-deploy curl actually proves something.
    let database = true;
    try {
      await env.DB.prepare("SELECT 1").first();
    } catch {
      database = false;
    }
    const status = await operationalStatus(env);
    return json(
      {
        status: database ? "ready" : "degraded",
        database,
        scheduler: status.schedulerRunning ? "running" : "stopped",
        mcp: { door: "/mcp", admin: "/mcp/admin" },
        settings: "/settings",
      },
      database ? 200 : 503,
    );
  }

  // --- Gmail/Google OAuth (ADR-0033): begin ---
  // GET /settings/oauth/:pluginId/start redirects to Google's consent screen;
  // GET /settings/oauth/callback exchanges the code and stores the refresh token.
  // Both are gated behind the same Basic auth as /settings itself.
  if (request.method === "GET" && url.pathname.startsWith("/settings/oauth/") && url.pathname.endsWith("/start")) {
    const authError = requireBasicAuth(request, env.ADMIN_TOKEN);
    if (authError) return authError;
    const pluginId = url.pathname.split("/")[3];
    if (!pluginId) {
      return json({ error: "oauth_invalid_request" }, 400);
    }
    try {
      const redirectUrl = await startAuthorization(pluginId, "google", env as unknown as OAuthEnv, url);
      return Response.redirect(redirectUrl, 302);
    } catch (error) {
      const code = error instanceof OAuthError ? error.code : "oauth_start_failed";
      console.error(JSON.stringify({ event: "oauth_start_failed", pluginId, code }));
      return json({ error: code }, 400);
    }
  }

  if (request.method === "GET" && url.pathname === "/settings/oauth/callback") {
    const authError = requireBasicAuth(request, env.ADMIN_TOKEN);
    if (authError) return authError;
    try {
      const { pluginId } = await handleCallback(url, env as unknown as OAuthEnv);
      // The Gmail preset manifest installs itself the first time its OAuth
      // connection succeeds, so "Connect Gmail" is genuinely one click.
      if (pluginId === "gmail") {
        await new D1ManifestStore(env.DB).upsert(gmailPreset);
      }
      return Response.redirect(new URL(`/settings?connected=${encodeURIComponent(pluginId)}`, url).toString(), 302);
    } catch (error) {
      const code = error instanceof OAuthError ? error.code : "oauth_callback_failed";
      console.error(JSON.stringify({ event: "oauth_callback_failed", code }));
      return json({ error: code }, 400);
    }
  }
  // --- Gmail/Google OAuth (ADR-0033): end ---

  // --- Door OAuth connectors (ADR-0035): begin ---
  // The consent page sits behind the same Basic auth as /settings: for a single-user
  // deployment, approving a connector is entering ADMIN_TOKEN. CSRF on the POST is the
  // OAuthProvider library's job (a single-use, cookie-bound consent handle) — see
  // oauth-server.ts's module comment.
  if (url.pathname === "/authorize" && (request.method === "GET" || request.method === "POST")) {
    const authError = requireBasicAuth(request, env.ADMIN_TOKEN);
    if (authError) return authError;
    return handleAuthorize(request, oauthHelpers);
  }

  if (request.method === "POST" && url.pathname === "/settings/oauth/apps/revoke") {
    const authError = requireBasicAuth(request, env.ADMIN_TOKEN);
    if (authError) return authError;
    if (request.headers.get("origin") !== url.origin) {
      return new Response("Invalid request origin.", { status: 403 });
    }
    return handleRevokeApp(request, oauthHelpers);
  }
  // --- Door OAuth connectors (ADR-0035): end ---

  if (url.pathname === "/settings" || url.pathname.startsWith("/settings/")) {
    return handleSettings(request, {
      adminToken: env.ADMIN_TOKEN,
      repository: new D1SettingsRepository(env.DB),
      sourceEnv: env,
      credentials: new D1SourceCredentialStore(env.DB, env.ADMIN_TOKEN),
      lastCycle: await loadLastCycle(env.DB),
      itemCounts: await itemCountsByPlugin(env.DB),
      mcpToken: env.MCP_TOKEN,
      connections: {
        mcp: Boolean(env.MCP_TOKEN),
        google: Boolean((env as unknown as OAuthEnv).PLUGIN_SECRET_GOOGLE_CLIENT_ID && (env as unknown as OAuthEnv).PLUGIN_SECRET_GOOGLE_CLIENT_SECRET),
        gmailConnected: await new D1OAuthTokenStore(env.DB).has("gmail"),
      },
      status: await operationalStatus(env),
      oauth: { grants: await listConnectedApps(oauthHelpers) },
      runSync: async () => {
        const cycle = await runCycle(env, true);
        const failed = cycle.sources.find((source) => source.lastError);
        return failed ? { ok: false, error: `${failed.plugin}: ${failed.lastError}` } : { ok: true };
      },
      startScheduler: async () => {
        try {
          const id = env.SCHEDULER.idFromName("primary");
          const response = await env.SCHEDULER.get(id).fetch(new Request("https://scheduler/start", { method: "POST" }));
          return response.ok ? { ok: true } : { ok: false, error: `scheduler responded ${response.status}` };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : "start_failed" };
        }
      },
    });
  }

  if (url.pathname === "/schedule") {
    if (!bearerOk(request, env.ADMIN_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
    const path = request.method === "POST" ? "/start" : request.method === "DELETE" ? "/stop" : "/status";
    const id = env.SCHEDULER.idFromName("primary");
    return env.SCHEDULER.get(id).fetch(new Request(`https://scheduler${path}`, { method: request.method }));
  }

  if (url.pathname === "/mcp/admin") {
    // The operator surface (ADR-0030): the kernel-shaped tools, bearer
    // ADMIN_TOKEN. Client agents never mount this, and — unlike /mcp — the
    // default export routes this path here directly, bypassing the OAuth
    // provider entirely, so an OAuth access token cannot authenticate here
    // even if presented as a bearer.
    if (!bearerOk(request, env.ADMIN_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { "content-type": "application/json", allow: "POST" },
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    const server = createAdminMcpServer(new D1McpRepository(env.DB), { db: env.DB });
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  if (request.method === "POST" && url.pathname === "/probe") {
    if (!bearerOk(request, env.ADMIN_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      return json(
        await probeMoodle({
          MOODLE_BASE_URL: env.MOODLE_BASE_URL,
          MOODLE_SESSION: env.MOODLE_SESSION ?? "",
        }),
      );
    } catch (error) {
      const code = error instanceof MoodleProbeError ? error.code : "probe_failed";
      console.error(JSON.stringify({ event: "moodle_probe_failed", code }));
      return json({ error: code }, 502);
    }
  }

  if (request.method === "POST" && url.pathname === "/sync") {
    if (!bearerOk(request, env.ADMIN_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
    const cycle = await runCycle(env, true);
    return json(cycle, cycle.sources.some((source) => source.lastError) ? 207 : 200);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // The OAuthProvider's apiRoute matching treats any sub-path of "/mcp" as the door's own
    // resource, by design (it's meant for REST-style resource hierarchies) — that would swallow
    // "/mcp/admin" too, routing an OAuth- or MCP_TOKEN-authenticated request straight to the door
    // handler instead of the admin one, and rejecting a plain ADMIN_TOKEN bearer as an invalid
    // OAuth token before defaultFetch ever runs. So this one path skips the provider entirely and
    // goes straight to defaultFetch, which gates it with its own bearer-ADMIN_TOKEN check — the
    // only way to structurally guarantee an OAuth access token can never reach it.
    if (url.pathname === "/mcp/admin") {
      return defaultFetch(request, env, context);
    }

    // Wraps everything else (ADR-0035): the provider owns `/mcp` itself (bearer MCP_TOKEN or an
    // OAuth access token — see oauth-server.ts's resolveExternalToken), the token/registration/
    // well-known endpoints, and hands the rest to defaultFetch above.
    const provider = createOAuthProvider(env, url.origin, handleDoor, defaultFetch);
    return provider.fetch(request, env, context);
  },
} satisfies ExportedHandler<Env>;
