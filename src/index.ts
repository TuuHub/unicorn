import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { D1McpRepository } from "./mcp/d1-repository";
import { createUnicornMcpServer } from "./mcp/server";
import { MoodleProbeError, probeMoodle } from "./moodle-probe";
import { runCycle, type Env } from "./runtime/cycle";
import { D1SettingsRepository, handleSettings } from "./settings";

export { Scheduler } from "./runtime/cycle";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ready", mcp: "/mcp", settings: "/settings" });
    }

    if (url.pathname === "/settings") {
      return handleSettings(request, {
        adminToken: env.ADMIN_TOKEN,
        repository: new D1SettingsRepository(env.DB),
        connections: {
          moodle: Boolean(env.MOODLE_SESSION),
          ed: Boolean(env.ED_API_TOKEN),
          mcp: Boolean(env.MCP_TOKEN),
          notifier: Boolean(env.NOTIFIER_URL),
        },
      });
    }

    if (url.pathname === "/schedule") {
      if (!env.ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ error: "unauthorized" }, 401);
      }
      const path = request.method === "POST" ? "/start" : request.method === "DELETE" ? "/stop" : "/status";
      const id = env.SCHEDULER.idFromName("primary");
      return env.SCHEDULER.get(id).fetch(new Request(`https://scheduler${path}`, { method: request.method }));
    }

    if (url.pathname === "/mcp") {
      if (!env.MCP_TOKEN || request.headers.get("authorization") !== `Bearer ${env.MCP_TOKEN}`) {
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
      if (!env.ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
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
      if (!env.ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ error: "unauthorized" }, 401);
      }
      const cycle = await runCycle(env, true);
      return json(cycle, cycle.errors.length ? 207 : 200);
    }

    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
