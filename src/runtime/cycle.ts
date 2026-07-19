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
import { DeclarativePlugin, pluginBindings } from "../plugins/declarative/plugin";
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
      // Log counts only, never the digest prose or triage reasons — observability
      // logs are long-lived and this is personal academic content.
      console.log(
        JSON.stringify({
          event: "scheduler_cycle_completed",
          plugins: cycle.results.length,
          events: cycle.results.reduce((total, result) => total + result.events, 0),
          errors: cycle.errors.length,
          archived: cycle.archived,
          triage: cycle.triage.status,
          digest: cycle.digest.status,
          delivered: cycle.delivered,
          skipped: cycle.skipped,
        }),
      );
    } catch (error) {
      // Log the message (server-side, low-sensitivity) so a first-tick schema or
      // config failure is distinguishable from a transient network blip.
      const message = error instanceof Error ? error.message : "unknown";
      console.error(JSON.stringify({ event: "scheduler_cycle_failed", code: "cycle_failed", message }));
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
  const triageEnabled = await isJobEnabled(env.DB, "triage");
  if (settings.notificationsEnabled) {
    // When triage is on it owns change notifications; the generic sync notice
    // would double-ping the same items, so it degrades to errors-only.
    await enqueueSyncNotice(outbox, env, summary, triageEnabled);
  }
  const triage = await runTriage(env, outbox, settings.notificationsEnabled);
  const digest = await runDigest(env, outbox, settings.notificationsEnabled);

  // Deliver last, once every enqueue for this cycle has landed. Delivery is
  // idempotent and retries on its own schedule, so a mid-cycle crash before this
  // line just means the next cycle drains the outbox.
  const delivered = await outbox.deliver(env);
  await outbox.prune(settings.retentionDays);
  const cycle: CycleResult = { ...summary, archived, triage, digest, delivered, skipped };
  await recordCycle(env.DB, cycle);
  return cycle;
}

// Persist a compact summary of the last cycle so /settings and the MCP
// get_sync_status tool can answer "did the last sync work, and when?" without
// digging through observability logs. Best-effort: a write failure never
// breaks the cycle itself.
async function recordCycle(db: D1Database, cycle: CycleResult): Promise<void> {
  const summary = {
    at: new Date().toISOString(),
    skipped: cycle.skipped,
    results: cycle.results,
    errors: cycle.errors,
    archived: cycle.archived,
    triage: cycle.triage.status,
    digest: cycle.digest.status,
    delivered: cycle.delivered,
  };
  try {
    await db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('last_cycle', ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(summary), summary.at)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error(JSON.stringify({ event: "cycle_record_failed", message }));
  }
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
        // Day-bucket the key so a retried cycle within the day dedupes, but a
        // genuinely recurring identical alert on a later day still sends.
        await enqueueBroadcast(outbox, env, `triage:${dayKey()}:${hash(body)}`, title, body);
      }
    },
  );
  const result = await runner.run();
  // The model budget crossing the cap is worth one notice: reflexes keep running,
  // but ambiguous events are kept un-judged until next month.
  if (notificationsEnabled && result.status === "completed" && result.budgetExhausted) {
    await enqueueBroadcast(
      outbox,
      env,
      `triage-paused:${dayKey()}`,
      "unicorn triage model paused",
      "Triage reached its monthly token cap. Deterministic alerts keep working, but ambiguous changes are no longer model-filtered (you may see more notifications). Raise the cap with the configure_agent_job MCP tool or wait for next month.",
    );
  }
  return result;
}

async function runDigest(
  env: Env,
  outbox: NotificationOutbox,
  notificationsEnabled: boolean,
): Promise<DigestResult | { status: "not_configured" }> {
  if (!env.AI_API_KEY) {
    return { status: "not_configured" };
  }
  // One clock read drives both the runner's `already_ran` day gate and the
  // idempotency key below, so a run that straddles UTC midnight can't gate on one day
  // and key on the next (which would let ON CONFLICT drop the next day's real digest).
  const now = new Date();
  const key = now.toISOString().slice(0, 10);
  const result = await new DailyDigestRunner(
    new D1JobStore(env.DB),
    new D1DigestDataSource(env.DB),
    new AiSdkTextGenerator({ apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL }),
  ).run(now);
  if (!notificationsEnabled) {
    return result;
  }
  if (result.status === "completed") {
    await enqueueBroadcast(outbox, env, `digest:${key}`, "unicorn daily digest", result.text);
    if (result.budgetExhausted) {
      await enqueueBudgetExhausted(outbox, env);
    }
  } else if (result.status === "budget_exhausted") {
    await enqueueBudgetExhausted(outbox, env);
  } else if (result.status === "failed") {
    await enqueueBroadcast(
      outbox,
      env,
      `digest-failed:${key}`,
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
  const bindings = pluginBindings(env as unknown as Record<string, unknown>);
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

async function enqueueSyncNotice(outbox: NotificationOutbox, env: Env, summary: SyncSummary, triageEnabled: boolean): Promise<void> {
  if (configuredChannels(env).length === 0) {
    return;
  }
  const eventCount = summary.results.reduce((total, result) => total + result.events, 0);
  const changesWorthNoting = !triageEnabled && eventCount > 0;
  if (!changesWorthNoting && summary.errors.length === 0) {
    return;
  }
  const lines = changesWorthNoting
    ? summary.results
        .filter((result) => result.events > 0)
        .map((result) => `${result.plugin}: ${result.events} change${result.events === 1 ? "" : "s"}`)
    : [];
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

// Whether an agent job is currently enabled; used to avoid double-notifying when
// triage owns the change stream. Best-effort — a read failure means "not enabled".
async function isJobEnabled(db: D1Database, id: string): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT enabled FROM agent_jobs WHERE id = ?").bind(id).first<{ enabled: number }>();
    return row?.enabled === 1;
  } catch {
    return false;
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
