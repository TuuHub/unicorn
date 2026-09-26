import { D1BriefStore } from "../briefs";
import { runDailyDigest, type DigestOutcome } from "../digest";
import { D1ItemStore } from "../kernel/d1-item-store";
import { labelStructure } from "../kernel/courses";
import { Kernel, type InvalidItemError } from "../kernel/kernel";
import { EdPlugin } from "../plugins/campus/ed-plugin";
import { MoodlePlugin } from "../plugins/campus/moodle-plugin";
import { DeclarativePlugin, pluginBindings } from "../plugins/declarative/plugin";
import { D1ManifestStore } from "../plugins/declarative/store";
import type { Plugin } from "../plugins/plugin";
import { D1RetentionRepository, runRetention } from "../retention";
import { D1SettingsRepository } from "../settings";
import { getAccessToken } from "../oauth";
import { MoodleProbeError } from "../moodle-probe";

// ADR-0034: no model runtime, no notifier — this is the whole Env now.
export interface Env {
  ADMIN_TOKEN: string;
  DB: D1Database;
  ED_API_TOKEN?: string;
  MCP_TOKEN: string;
  MOODLE_BASE_URL: string;
  MOODLE_SESSION?: string;
  SCHEDULER: DurableObjectNamespace;
  PLUGIN_SECRET_GOOGLE_CLIENT_ID?: string;
  PLUGIN_SECRET_GOOGLE_CLIENT_SECRET?: string;
}

export interface SourceCycleResult {
  plugin: string;
  lastSyncAt: string;
  lastError: string | null;
  pulled: number;
  created: number;
  updated: number;
  unchanged: number;
  events: number;
}

export interface CycleResult {
  at: string;
  skipped: boolean;
  sources: SourceCycleResult[];
  labeled: number;
  digest: DigestOutcome;
  archived: number;
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
      // Log counts only, never item titles or digest prose — observability logs
      // are long-lived and this is personal academic content.
      console.log(
        JSON.stringify({
          event: "scheduler_cycle_completed",
          sources: cycle.sources.length,
          events: cycle.sources.reduce((total, source) => total + source.events, 0),
          errors: cycle.sources.filter((source) => source.lastError).length,
          labeled: cycle.labeled,
          digest: cycle.digest.status,
          archived: cycle.archived,
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

// Cycle shape (ADR-0034): sync sources -> ingest -> label structure -> digest
// -> retention -> record last_cycle. No triage, no notifier, no playbooks —
// those either don't exist anymore or moved out of the Worker.
export async function runCycle(env: Env, forceSync: boolean, now: () => Date = () => new Date()): Promise<CycleResult> {
  const settings = await new D1SettingsRepository(env.DB).get();
  const skipped = !forceSync && !settings.syncEnabled;
  const sources = skipped ? [] : await syncSources(env);

  const { labeled } = await labelStructure(env.DB).catch((error): { labeled: number } => {
    console.error(JSON.stringify({ event: "label_structure_failed", message: errorMessage(error) }));
    return { labeled: 0 };
  });

  const digest = await runDailyDigest(env.DB, new D1BriefStore(env.DB), settings.timezone, now()).catch(
    (error): DigestOutcome => {
      console.error(JSON.stringify({ event: "digest_failed", message: errorMessage(error) }));
      return { status: "skipped", reason: "empty" };
    },
  );

  const archived = await runRetention(new D1RetentionRepository(env.DB), settings.retentionDays, now());
  await new D1BriefStore(env.DB).prune(settings.retentionDays);

  const cycle: CycleResult = { at: now().toISOString(), skipped, sources, labeled, digest, archived };
  await recordCycle(env.DB, cycle);
  return cycle;
}

// Persist a compact summary of the last cycle so /settings and the MCP
// get_sync_status tool can answer "did the last sync work, and when?" without
// digging through observability logs. Best-effort: a write failure never
// breaks the cycle itself.
async function recordCycle(db: D1Database, cycle: CycleResult): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('last_cycle', ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(cycle), cycle.at)
      .run();
  } catch (error) {
    console.error(JSON.stringify({ event: "cycle_record_failed", message: errorMessage(error) }));
  }
}

async function syncSources(env: Env): Promise<SourceCycleResult[]> {
  const plugins: Plugin[] = [];
  if (env.MOODLE_SESSION) {
    plugins.push(new MoodlePlugin({ baseUrl: env.MOODLE_BASE_URL, session: env.MOODLE_SESSION }));
  }
  if (env.ED_API_TOKEN) {
    plugins.push(new EdPlugin({ token: env.ED_API_TOKEN }));
  }
  const manifests = await new D1ManifestStore(env.DB).list(true);
  const bindings = pluginBindings(env as unknown as Record<string, unknown>);
  // OAuth-backed MCP sources (ADR-0033) resolve their access token from D1 at pull time.
  plugins.push(
    ...manifests.map(
      ({ manifest }) => new DeclarativePlugin(manifest, bindings, undefined, (pluginId) => getAccessToken(pluginId, env)),
    ),
  );

  const kernel = new Kernel(new D1ItemStore(env.DB));
  const results: SourceCycleResult[] = [];
  for (const plugin of plugins) {
    const lastSyncAt = new Date().toISOString();
    let items;
    try {
      items = await plugin.pull();
    } catch (error) {
      const code = syncErrorCode(error);
      console.error(JSON.stringify({ event: "plugin_sync_failed", plugin: plugin.id, stage: "pull", code }));
      results.push({ plugin: plugin.id, lastSyncAt, lastError: `pull:${code}`, pulled: 0, created: 0, updated: 0, unchanged: 0, events: 0 });
      continue;
    }

    try {
      const result = await kernel.ingest(items);
      results.push({
        plugin: plugin.id,
        lastSyncAt,
        lastError: null,
        pulled: items.length,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        events: result.events.length,
      });
    } catch (error) {
      const code = syncErrorCode(error);
      console.error(JSON.stringify({ event: "plugin_sync_failed", plugin: plugin.id, stage: "ingest", code }));
      results.push({ plugin: plugin.id, lastSyncAt, lastError: `ingest:${code}`, pulled: items.length, created: 0, updated: 0, unchanged: 0, events: 0 });
    }
  }
  return results;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
