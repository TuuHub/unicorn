import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { D1ItemStore } from "./kernel/d1-item-store";
import { Kernel, type InvalidItemError } from "./kernel/kernel";
import { D1McpRepository } from "./mcp/d1-repository";
import { createUnicornMcpServer } from "./mcp/server";
import { MoodleProbeError, probeMoodle, type MoodleProbeEnv } from "./moodle-probe";
import { EdPlugin } from "./plugins/campus/ed-plugin";
import { MoodlePlugin } from "./plugins/campus/moodle-plugin";
import { DeclarativePlugin } from "./plugins/declarative/plugin";
import { D1ManifestStore } from "./plugins/declarative/store";
import type { Plugin } from "./plugins/plugin";

interface Env extends MoodleProbeEnv {
  DB: D1Database;
  ED_API_TOKEN?: string;
  MCP_TOKEN: string;
  PROBE_TOKEN: string;
}

interface SyncSummary {
  results: Array<{ plugin: string; pulled: number; created: number; updated: number; unchanged: number; events: number }>;
  errors: Array<{ plugin: string; code: string }>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ready", mcp: "/mcp" });
    }

    if (url.pathname === "/mcp") {
      if (request.headers.get("authorization") !== `Bearer ${env.MCP_TOKEN}`) {
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
      if (request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`) {
        return json({ error: "unauthorized" }, 401);
      }

      try {
        return json(await probeMoodle(env));
      } catch (error) {
        const code = error instanceof MoodleProbeError ? error.code : "probe_failed";
        console.error(JSON.stringify({ event: "moodle_probe_failed", code }));
        return json({ error: code }, 502);
      }
    }

    if (request.method === "POST" && url.pathname === "/sync") {
      if (request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`) {
        return json({ error: "unauthorized" }, 401);
      }
      const summary = await syncSources(env);
      return json(summary, summary.errors.length ? 207 : 200);
    }

    return json({ error: "not_found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const summary = await syncSources(env);
    console.log(JSON.stringify({ event: "campus_sync_completed", ...summary }));
    if (summary.errors.length) {
      throw new Error(`Campus sync failed for ${summary.errors.map((error) => error.plugin).join(", ")}.`);
    }
  },
} satisfies ExportedHandler<Env>;

async function syncSources(env: Env): Promise<SyncSummary> {
  const plugins: Plugin[] = [
    new MoodlePlugin({ baseUrl: env.MOODLE_BASE_URL, session: env.MOODLE_SESSION }),
  ];
  if (env.ED_API_TOKEN) {
    plugins.push(new EdPlugin({ token: env.ED_API_TOKEN }));
  }
  const manifests = await new D1ManifestStore(env.DB).list(true);
  const bindings = env as unknown as Record<string, unknown>;
  plugins.push(...manifests.map(({ manifest }) => new DeclarativePlugin(manifest, bindings)));

  const kernel = new Kernel(new D1ItemStore(env.DB));
  const summary: SyncSummary = { results: [], errors: [] };
  for (const plugin of plugins) {
    let items;
    try {
      items = await plugin.pull();
    } catch (error) {
      const code = syncErrorCode(error);
      console.error(JSON.stringify({ event: "plugin_sync_failed", plugin: plugin.id, stage: "pull", code }));
      summary.errors.push({ plugin: plugin.id, code: `pull:${code}` });
      continue;
    }

    try {
      const result = await kernel.ingest(items);
      summary.results.push({
        plugin: plugin.id,
        pulled: items.length,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        events: result.events.length,
      });
    } catch (error) {
      const code = syncErrorCode(error);
      console.error(JSON.stringify({ event: "plugin_sync_failed", plugin: plugin.id, stage: "ingest", code }));
      summary.errors.push({ plugin: plugin.id, code: `ingest:${code}` });
    }
  }
  return summary;
}

function syncErrorCode(error: unknown): string {
  if (error instanceof MoodleProbeError) {
    return error.code;
  }
  if (error && typeof error === "object" && "code" in error) {
    return String((error as InvalidItemError).code);
  }
  return "sync_failed";
}
