import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { renderDigestReport } from "./digest-report";
import { D1McpRepository } from "./mcp/d1-repository";
import { createUnicornMcpServer } from "./mcp/server";
import { MoodleProbeError, probeMoodle } from "./moodle-probe";
import { runCycle, type Env } from "./runtime/cycle";
import { constantTimeEqual, D1SettingsRepository, handleSettings, isBasicAuthorized } from "./settings";

export { Scheduler } from "./runtime/cycle";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

// Live operational state shared by /health and /settings: is the hourly scheduler
// alarm set, and how many notifications have permanently failed. Both checks are
// best-effort — a failure reports as degraded rather than throwing.
async function operationalStatus(env: Env): Promise<{ schedulerRunning: boolean; failedNotifications: number }> {
  let schedulerRunning = false;
  try {
    const id = env.SCHEDULER.idFromName("primary");
    const response = await env.SCHEDULER.get(id).fetch(new Request("https://scheduler/status"));
    const body = (await response.json()) as { scheduled?: boolean };
    schedulerRunning = body.scheduled === true;
  } catch {
    schedulerRunning = false;
  }
  let failedNotifications = 0;
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications_outbox WHERE status = 'failed'").first<{ n: number }>();
    failedNotifications = row?.n ?? 0;
  } catch {
    failedNotifications = 0;
  }
  return { schedulerRunning, failedNotifications };
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
  async fetch(request: Request, env: Env): Promise<Response> {
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
          mcp: "/mcp",
          settings: "/settings",
          digest: "/digest",
        },
        database ? 200 : 503,
      );
    }

    if (request.method === "GET" && url.pathname === "/digest") {
      // The digest is personal academic data; gate it behind the same Basic auth as
      // /settings rather than serving it on a guessable public workers.dev URL.
      if (!isBasicAuthorized(request.headers.get("authorization"), env.ADMIN_TOKEN)) {
        return new Response("Authentication required.", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="unicorn digest", charset="UTF-8"' },
        });
      }
      return renderDigestReport(env.DB);
    }

    if (url.pathname === "/settings") {
      return handleSettings(request, {
        adminToken: env.ADMIN_TOKEN,
        repository: new D1SettingsRepository(env.DB),
        connections: {
          moodle: Boolean(env.MOODLE_SESSION),
          ed: Boolean(env.ED_API_TOKEN),
          mcp: Boolean(env.MCP_TOKEN),
          notifier: Boolean(env.NOTIFIER_URL || (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) || (env.RESEND_API_KEY && env.EMAIL_FROM && env.EMAIL_TO)),
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
      const server = createUnicornMcpServer(new D1McpRepository(env.DB));
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
      return json(cycle, cycle.errors.length ? 207 : 200);
    }

    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
