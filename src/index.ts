import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { D1BriefStore } from "./briefs";
import { D1MemoryStore } from "./memory";
import { D1McpRepository } from "./mcp/d1-repository";
import { createDoorMcpServer } from "./mcp/door";
import { createAdminMcpServer } from "./mcp/server";
import { MoodleProbeError, probeMoodle } from "./moodle-probe";
import { D1OAuthTokenStore, handleCallback, OAuthError, startAuthorization, type OAuthEnv } from "./oauth";
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

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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
      if (!isBasicAuthorized(request.headers.get("authorization"), env.ADMIN_TOKEN)) {
        return new Response("Authentication required.", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="unicorn settings", charset="UTF-8"' },
        });
      }
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
      if (!isBasicAuthorized(request.headers.get("authorization"), env.ADMIN_TOKEN)) {
        return new Response("Authentication required.", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="unicorn settings", charset="UTF-8"' },
        });
      }
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
        runSync: async () => {
          const cycle = await runCycle(env, true);
          const failed = cycle.sources.find((source) => source.lastError);
          return failed ? { ok: false, error: `${failed.plugin}: ${failed.lastError}` } : { ok: true };
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

    if (url.pathname === "/mcp") {
      // The door (ADR-0030/0034): a memory-layer tool set for a client agent,
      // bearer MCP_TOKEN.
      if (!bearerOk(request, env.MCP_TOKEN)) {
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
      const server = createDoorMcpServer({
        briefs: new D1BriefStore(env.DB),
        memory: new D1MemoryStore(env.DB),
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    if (url.pathname === "/mcp/admin") {
      // The operator surface (ADR-0030): the kernel-shaped tools, bearer
      // ADMIN_TOKEN. Client agents never mount this.
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
      const server = createAdminMcpServer(new D1McpRepository(env.DB));
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
  },
} satisfies ExportedHandler<Env>;
