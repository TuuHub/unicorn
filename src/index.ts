import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { D1BriefStore } from "./briefs";
import { D1MemoryStore } from "./memory";
import { D1McpRepository } from "./mcp/d1-repository";
import { createDoorMcpServer } from "./mcp/door";
import { D1DoorRepository } from "./mcp/door-repository";
import { createAdminMcpServer } from "./mcp/server";
import { MoodleProbeError, probeMoodle } from "./moodle-probe";
import { D1OAuthTokenStore, handleCallback, OAuthError, startAuthorization, type OAuthEnv } from "./oauth";
import { D1ManifestStore } from "./plugins/declarative/store";
import gmailPreset from "./plugins/presets/gmail.json";
import { runCycle, Scheduler, type Env } from "./runtime/cycle";
import { constantTimeEqual, D1SettingsRepository, handleSettings, isBasicAuthorized } from "./settings";

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

    if (url.pathname === "/settings") {
      return handleSettings(request, {
        adminToken: env.ADMIN_TOKEN,
        repository: new D1SettingsRepository(env.DB),
        connections: {
          moodle: Boolean(env.MOODLE_SESSION),
          ed: Boolean(env.ED_API_TOKEN),
          mcp: Boolean(env.MCP_TOKEN),
          google: Boolean((env as unknown as OAuthEnv).PLUGIN_SECRET_GOOGLE_CLIENT_ID && (env as unknown as OAuthEnv).PLUGIN_SECRET_GOOGLE_CLIENT_SECRET),
          gmailConnected: await new D1OAuthTokenStore(env.DB).has("gmail"),
        },
        status: await operationalStatus(env),
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
        repo: new D1DoorRepository(env.DB),
        settings: new D1SettingsRepository(env.DB),
        schedulerStatus: async () => ({ running: (await operationalStatus(env)).schedulerRunning }),
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
