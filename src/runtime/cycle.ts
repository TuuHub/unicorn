import { DailyDigestRunner, type DigestResult } from "../jobs/daily-digest";
import { D1JobStore } from "../jobs/d1-job-store";
import { AiSdkTextGenerator, D1DigestDataSource } from "../jobs/runtime";
import { D1ItemStore } from "../kernel/d1-item-store";
import { Kernel, type InvalidItemError } from "../kernel/kernel";
import { MoodleProbeError } from "../moodle-probe";
import { DiscordNotifier } from "../notifier";
import { EdPlugin } from "../plugins/campus/ed-plugin";
import { MoodlePlugin } from "../plugins/campus/moodle-plugin";
import { DeclarativePlugin } from "../plugins/declarative/plugin";
import { D1ManifestStore } from "../plugins/declarative/store";
import type { Plugin } from "../plugins/plugin";
import { D1RetentionRepository, runRetention } from "../retention";
import { D1SettingsRepository } from "../settings";

export interface Env {
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

export interface CycleResult extends SyncSummary {
  archived: number;
  digest: DigestResult | { status: "not_configured" };
  skipped: boolean;
}

export class Scheduler {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/start") {
      await this.state.storage.setAlarm(Date.now() + 5_000);
      return Response.json({ scheduled: true });
    }
    if (request.method === "DELETE" && url.pathname === "/stop") {
      await this.state.storage.deleteAlarm();
      return Response.json({ scheduled: false });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const nextAlarm = await this.state.storage.getAlarm();
      return Response.json({ scheduled: nextAlarm !== null, nextAlarm });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
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

export async function runCycle(env: Env, forceSync: boolean): Promise<CycleResult> {
  const settings = await new D1SettingsRepository(env.DB).get();
  const skipped = !forceSync && !settings.syncEnabled;
  const summary = skipped ? { results: [], errors: [] } : await syncSources(env);
  const archived = await runRetention(new D1RetentionRepository(env.DB), settings.retentionDays);
  await notifySync(env, settings.notificationsEnabled, summary);
  const digest = await runDigest(env, settings.notificationsEnabled);
  return { ...summary, archived, digest, skipped };
}

async function runDigest(
  env: Env,
  notificationsEnabled: boolean,
): Promise<DigestResult | { status: "not_configured" }> {
  if (!env.AI_API_KEY) {
    return { status: "not_configured" };
  }
  const result = await new DailyDigestRunner(
    new D1JobStore(env.DB),
    new D1DigestDataSource(env.DB),
    new AiSdkTextGenerator({ apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL }),
  ).run();
  if (!notificationsEnabled || !env.NOTIFIER_URL) {
    return result;
  }
  if (result.status === "completed") {
    await sendNotification(env.NOTIFIER_URL, "unicorn daily digest", result.text);
  } else if (result.status === "budget_exhausted") {
    await sendNotification(
      env.NOTIFIER_URL,
      "unicorn digest paused",
      "The daily digest reached its monthly token cap and was disabled. Ingestion is still running.",
    );
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
  await sendNotification(
    env.NOTIFIER_URL,
    summary.errors.length ? "unicorn sync needs attention" : "unicorn found changes",
    lines.join("\n"),
  );
}

async function sendNotification(url: string, title: string, body: string): Promise<void> {
  try {
    await new DiscordNotifier(url).send({ title, body });
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
