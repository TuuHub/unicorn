import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { D1ItemStore } from "./kernel/d1-item-store";
import { Kernel, type InvalidItemError } from "./kernel/kernel";
import { DailyDigestRunner, type DigestResult } from "./jobs/daily-digest";
import { D1JobStore } from "./jobs/d1-job-store";
import { AiSdkTextGenerator, D1DigestDataSource } from "./jobs/runtime";
import { D1McpRepository } from "./mcp/d1-repository";
import { createUnicornMcpServer } from "./mcp/server";
import { MoodleProbeError, probeMoodle } from "./moodle-probe";
import { DiscordNotifier } from "./notifier";
import { EdPlugin } from "./plugins/campus/ed-plugin";
import { MoodlePlugin } from "./plugins/campus/moodle-plugin";
import { DeclarativePlugin } from "./plugins/declarative/plugin";
import { D1ManifestStore } from "./plugins/declarative/store";
import type { Plugin } from "./plugins/plugin";
import { D1RetentionRepository, runRetention } from "./retention";
import { D1SettingsRepository, handleSettings } from "./settings";

interface Env {
  ADMIN_TOKEN: string;
  AI_API_KEY?: string;
  AI_BASE_URL: string;
  DB: D1Database;
  ED_API_TOKEN?: string;
  MCP_TOKEN: string;
  MOODLE_BASE_URL: string;
  MOODLE_SESSION?: string;
  NOTIFIER_URL?: string;
  SCHEDULER: DurableObjectNamespace;
}

interface SyncSummary {
  results: Array<{ plugin: string; pulled: number; created: number; updated: number; unchanged: number; events: number }>;
  errors: Array<{ plugin: string; code: string }>;
}

interface CycleResult extends SyncSummary {
  archived: number;
  digest: DigestResult | { status: "not_configured" };
  skipped: boolean;
}

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

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const cycle = await runCycle(env, false);
    console.log(JSON.stringify({ event: "source_sync_completed", ...cycle }));
    if (cycle.errors.length) {
      throw new Error(`Source sync failed for ${cycle.errors.map((error) => error.plugin).join(", ")}.`);
    }
  },
} satisfies ExportedHandler<Env>;

export class Scheduler {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/start") {
      await this.state.storage.setAlarm(Date.now() + 5_000);
      return json({ scheduled: true });
    }
    if (request.method === "DELETE" && url.pathname === "/stop") {
      await this.state.storage.deleteAlarm();
      return json({ scheduled: false });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const nextAlarm = await this.state.storage.getAlarm();
      return json({ scheduled: nextAlarm !== null, nextAlarm });
    }
    return json({ error: "not_found" }, 404);
  }

  async alarm(): Promise<void> {
    try {
      const cycle = await runCycle(this.env, false);
      console.log(JSON.stringify({ event: "scheduler_cycle_completed", ...cycle }));
    } catch {
      console.error(JSON.stringify({ event: "scheduler_cycle_failed", code: "cycle_failed" }));
    } finally {
      await this.state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    }
  }
}

async function runCycle(env: Env, forceSync: boolean): Promise<CycleResult> {
  const settings = await new D1SettingsRepository(env.DB).get();
  const skipped = !forceSync && !settings.syncEnabled;
  const summary = skipped ? { results: [], errors: [] } : await syncSources(env);
  const archived = await runRetention(new D1RetentionRepository(env.DB), settings.retentionDays);
  await notifySync(env, settings.notificationsEnabled, summary);
  const digest = await runDigest(env, settings.notificationsEnabled);
  return { ...summary, archived, digest, skipped };
}

async function runDigest(env: Env, notificationsEnabled: boolean): Promise<DigestResult | { status: "not_configured" }> {
  if (!env.AI_API_KEY) {
    return { status: "not_configured" };
  }
  const result = await new DailyDigestRunner(
    new D1JobStore(env.DB),
    new D1DigestDataSource(env.DB),
    new AiSdkTextGenerator({ apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL }),
  ).run();
  if (result.status === "completed" && notificationsEnabled && env.NOTIFIER_URL) {
    try {
      await new DiscordNotifier(env.NOTIFIER_URL).send({ title: "unicorn daily digest", body: result.text });
    } catch {
      console.error(JSON.stringify({ event: "notification_failed", code: "notifier_unavailable" }));
    }
  }
  return result;
}

async function syncSources(env: Env): Promise<SyncSummary> {
  const plugins: Plugin[] = [];
  if (env.MOODLE_SESSION) {
    plugins.push(new MoodlePlugin({ baseUrl: env.MOODLE_BASE_URL, session: env.MOODLE_SESSION }));
  }
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

async function notifySync(env: Env, enabled: boolean, summary: SyncSummary): Promise<void> {
  if (!enabled || !env.NOTIFIER_URL) {
    return;
  }
  const eventCount = summary.results.reduce((total, result) => total + result.events, 0);
  if (eventCount === 0 && summary.errors.length === 0) {
    return;
  }
  const lines = summary.results
    .filter((result) => result.events > 0)
    .map((result) => `${result.plugin}: ${result.events} change${result.events === 1 ? "" : "s"}`);
  lines.push(...summary.errors.map((error) => `${error.plugin}: ${error.code}`));
  try {
    await new DiscordNotifier(env.NOTIFIER_URL).send({
      title: summary.errors.length ? "unicorn sync needs attention" : "unicorn found changes",
      body: lines.join("\n"),
    });
  } catch {
    console.error(JSON.stringify({ event: "notification_failed", code: "notifier_unavailable" }));
  }
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
