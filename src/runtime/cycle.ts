import { DailyDigestRunner, type DigestResult } from "../jobs/daily-digest";
import { D1JobStore } from "../jobs/d1-job-store";
import {
  AiSdkTextGenerator,
  D1DigestDataSource,
  D1MemoryReader,
  D1TriageDataSource,
} from "../jobs/runtime";
import { TriageRunner, type TriageResult } from "../jobs/triage";
import { D1ItemStore } from "../kernel/d1-item-store";
import { Kernel, type InvalidItemError } from "../kernel/kernel";
import { MoodleProbeError } from "../moodle-probe";
import { configuredChannels, type NotifierEnv } from "../notifier";
import { enqueueBroadcast, NotificationOutbox } from "../outbox";
import { EdPlugin } from "../plugins/campus/ed-plugin";
import { MoodlePlugin } from "../plugins/campus/moodle-plugin";
import { DeclarativePlugin } from "../plugins/declarative/plugin";
import { D1ManifestStore } from "../plugins/declarative/store";
import type { Plugin } from "../plugins/plugin";
import { D1RetentionRepository, runRetention } from "../retention";
import { D1SettingsRepository } from "../settings";

export interface Env extends NotifierEnv {
  ADMIN_TOKEN: string;
  AI_API_KEY?: string;
  AI_BASE_URL: string;
  DB: D1Database;
  ED_API_TOKEN?: string;
  MCP_TOKEN: string;
  MOODLE_BASE_URL: string;
  MOODLE_SESSION?: string;
  SCHEDULER: DurableObjectNamespace;
}

interface SyncSummary {
  results: Array<{ plugin: string; pulled: number; created: number; updated: number; unchanged: number; events: number }>;
  errors: Array<{ plugin: string; code: string }>;
}

export interface CycleResult extends SyncSummary {
  archived: number;
  triage: TriageResult | { status: "not_configured" };
  digest: DigestResult | { status: "not_configured" };
  delivered: { delivered: number; failed: number; retrying: number };
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

  const outbox = new NotificationOutbox(env.DB);
  if (settings.notificationsEnabled) {
    await enqueueSyncNotice(outbox, env, summary);
  }
  const triage = await runTriage(env, outbox, settings.notificationsEnabled);
  const digest = await runDigest(env, outbox, settings.notificationsEnabled);

  // Deliver last, once every enqueue for this cycle has landed. Delivery is
  // idempotent and retries on its own schedule, so a mid-cycle crash before this
  // line just means the next cycle drains the outbox.
  const delivered = await outbox.deliver(env);
  return { ...summary, archived, triage, digest, delivered, skipped };
}

async function runTriage(
  env: Env,
  outbox: NotificationOutbox,
  notificationsEnabled: boolean,
): Promise<TriageResult | { status: "not_configured" }> {
  const runner = new TriageRunner(
    new D1JobStore(env.DB),
    new D1TriageDataSource(env.DB),
    new D1MemoryReader(env.DB),
    env.AI_API_KEY ? new AiSdkTextGenerator({ apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL }) : null,
    async (title, body) => {
      if (notificationsEnabled) {
        await enqueueBroadcast(outbox, env, `triage:${hash(body)}`, title, body);
      }
    },
  );
  return runner.run();
}

async function runDigest(
  env: Env,
  outbox: NotificationOutbox,
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
  if (!notificationsEnabled) {
    return result;
  }
  if (result.status === "completed") {
    await enqueueBroadcast(outbox, env, `digest:${dayKey()}`, "unicorn daily digest", result.text);
    if (result.budgetExhausted) {
      await enqueueBudgetExhausted(outbox, env);
    }
  } else if (result.status === "budget_exhausted") {
    await enqueueBudgetExhausted(outbox, env);
  } else if (result.status === "failed") {
    await enqueueBroadcast(
      outbox,
      env,
      `digest-failed:${dayKey()}`,
      "unicorn digest failed",
      "The daily digest model call failed and was skipped. Ingestion is still running.",
    );
  }
  return result;
}

function enqueueBudgetExhausted(outbox: NotificationOutbox, env: Env): Promise<void> {
  return enqueueBroadcast(
    outbox,
    env,
    `digest-paused:${dayKey()}`,
    "unicorn digest paused",
    "The daily digest reached its monthly token cap and was disabled. Ingestion is still running.",
  );
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

async function enqueueSyncNotice(outbox: NotificationOutbox, env: Env, summary: SyncSummary): Promise<void> {
  if (configuredChannels(env).length === 0) {
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
  const body = lines.join("\n");
  await enqueueBroadcast(
    outbox,
    env,
    `sync:${dayKey()}:${hash(body)}`,
    summary.errors.length ? "unicorn sync needs attention" : "unicorn found changes",
    body,
  );
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

// A stable per-day bucket so an identical sync notice in the same hourly retry
// window collapses to one delivery, while a genuinely new day sends again.
function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Small deterministic content hash for idempotency keys — collisions only cause a
// duplicate to be suppressed, never a wrong send, so a cheap 32-bit hash is fine.
function hash(value: string): string {
  let h = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
