import type { PlaybookId, PlaybookRunner, PlaybookRunResult } from "../agent/playbook-runner";
import { createPlaybookRunner } from "../agent/pi-playbook-runner";
import { D1BriefStore, type BriefKind, type BriefStore } from "../briefs";
import { DailyDigestRunner, type DigestResult } from "../jobs/daily-digest";
import { D1JobStore } from "../jobs/d1-job-store";
import { MemoryConsolidator } from "../jobs/memory-consolidation";
import { D1DigestDataSource, D1MemoryReader, D1TriageDataSource } from "../jobs/runtime";
import { TriageRunner, type TriageResult } from "../jobs/triage";
import { D1ItemStore } from "../kernel/d1-item-store";
import { Kernel, type InvalidItemError } from "../kernel/kernel";
import { D1MemoryStore } from "../memory";
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
import {
  createPiModelRuntime,
  PiTextGenerator,
  type WorkersAiBinding,
} from "../agent/pi-model";

export interface Env extends NotifierEnv {
  ADMIN_TOKEN: string;
  AI?: WorkersAiBinding;
  AI_API_KEY?: string;
  AI_BASE_URL: string;
  DB: D1Database;
  ED_API_TOKEN?: string;
  MCP_TOKEN: string;
  MOODLE_BASE_URL: string;
  MOODLE_SESSION?: string;
  AGENT_SESSIONS: DurableObjectNamespace;
  SCHEDULER: DurableObjectNamespace;
}

interface SyncSummary {
  results: Array<{ plugin: string; pulled: number; created: number; updated: number; unchanged: number; events: number }>;
  errors: Array<{ plugin: string; code: string }>;
}

// One outcome per scheduled playbook trigger (ADR-0031), counts and status codes
// only — never prompt or brief content, which stays out of logs and the persisted
// last_cycle summary.
export type PlaybookTriggerStatus =
  | { status: "not_due" }
  | { status: "already_done" }
  | { status: "completed" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; code: string };

export interface PlaybookCycleSummary {
  forumBrief: PlaybookTriggerStatus;
  weeklyPlan: PlaybookTriggerStatus;
  decomposeAssignment: { attempted: number; completed: number; skipped: number; failed: number };
}

export interface CycleResult extends SyncSummary {
  archived: number;
  triage: TriageResult | { status: "not_configured" | "failed" };
  digest: DigestResult | { status: "not_configured" };
  playbooks: PlaybookCycleSummary;
  delivered: { delivered: number; failed: number; retrying: number };
  skipped: boolean;
}

// Injected so the scheduler compiles and is testable against a fake runner before
// feat/brain's real src/agent/pi-playbook-runner.ts lands (see that file's stub).
export interface CycleDeps {
  playbookRunner?: PlaybookRunner;
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
          playbooks: {
            forumBrief: cycle.playbooks.forumBrief.status,
            weeklyPlan: cycle.playbooks.weeklyPlan.status,
            decomposeAssignment: cycle.playbooks.decomposeAssignment,
          },
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

export async function runCycle(env: Env, forceSync: boolean, deps: CycleDeps = {}): Promise<CycleResult> {
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
  // A job failure must not take down the rest of the cycle: digest still runs,
  // and — critically — the outbox still delivers whatever was already enqueued.
  const triage = await runTriage(env, outbox, settings.notificationsEnabled).catch((error): { status: "failed" } => {
    console.error(JSON.stringify({ event: "triage_failed", message: errorMessage(error) }));
    return { status: "failed" };
  });
  const digest = await runDigest(env, outbox, settings.notificationsEnabled).catch((error): { status: "failed" } => {
    console.error(JSON.stringify({ event: "digest_failed", message: errorMessage(error) }));
    return { status: "failed" };
  });
  // Resident memory hygiene (ADR-0024): when the notes near their cap, one
  // budget-capped model call compresses them. Best-effort; a failure only means
  // consolidation retries next cycle.
  const memory = await new MemoryConsolidator(
    new D1MemoryStore(env.DB),
    new D1JobStore(env.DB),
    createTextGenerator(env),
  )
    .run()
    .catch((error): { status: "failed" } => {
      console.error(JSON.stringify({ event: "memory_consolidation_failed", message: errorMessage(error) }));
      return { status: "failed" };
    });
  if (memory.status === "completed") {
    console.log(
      JSON.stringify({
        event: "memory_consolidated",
        beforeTokens: memory.beforeTokens,
        afterTokens: memory.afterTokens,
        totalTokens: memory.usage.totalTokens,
      }),
    );
  }

  // ADR-0031 scheduled playbooks: best-effort, bounded (the hourly alarm runs on
  // the free plan's CPU wall), after ingestion and before delivery so a completed
  // brief can ride the same outbox notice if a future job wants one.
  const playbooks = await runPlaybookTriggers(env, deps.playbookRunner ?? createPlaybookRunner(env), new Date()).catch(
    (error): PlaybookCycleSummary => {
      console.error(JSON.stringify({ event: "playbooks_failed", message: errorMessage(error) }));
      return {
        forumBrief: { status: "failed", code: "trigger_failed" },
        weeklyPlan: { status: "failed", code: "trigger_failed" },
        decomposeAssignment: { attempted: 0, completed: 0, skipped: 0, failed: 0 },
      };
    },
  );

  // Deliver last, once every enqueue for this cycle has landed. Delivery is
  // idempotent and retries on its own schedule, so a mid-cycle crash before this
  // line just means the next cycle drains the outbox.
  const delivered = await outbox.deliver(env);
  await outbox.prune(settings.retentionDays);
  await new D1BriefStore(env.DB).prune(settings.retentionDays);
  const cycle: CycleResult = { ...summary, archived, triage, digest, playbooks, delivered, skipped };
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
    playbooks: {
      forumBrief: cycle.playbooks.forumBrief.status,
      weeklyPlan: cycle.playbooks.weeklyPlan.status,
      decomposeAssignment: cycle.playbooks.decomposeAssignment,
    },
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
    createTextGenerator(env),
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
  if (!createPiModelRuntime(env)) {
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
    createTextGenerator(env)!,
  ).run(now);
  if (result.status === "completed") {
    // ADR-0031: get_briefs is the one inbox — the digest lands there independent of
    // whether push notifications are configured. Idempotent id: a retried cycle on
    // the same UTC day never duplicates it.
    await new D1BriefStore(env.DB).insert({
      id: `digest:${key}`,
      kind: "digest",
      subject: key,
      title: "unicorn daily digest",
      body: result.text,
      createdAt: now.toISOString(),
    });
  }
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

function createTextGenerator(env: Env): PiTextGenerator | null {
  const runtime = createPiModelRuntime(env);
  return runtime ? new PiTextGenerator(runtime) : null;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

// ADR-0031 scheduled triggers. Each is independently best-effort: one trigger's
// failure never blocks another, or the outbox delivery that follows.
const DECOMPOSE_ASSIGNMENT_CAP = 3;
const SUBMITTED_STATUSES = new Set(["submitted", "graded"]);

async function runPlaybookTriggers(env: Env, runner: PlaybookRunner, now: Date): Promise<PlaybookCycleSummary> {
  const jobs = new D1JobStore(env.DB);
  const briefs = new D1BriefStore(env.DB);
  let scheduleHourUtc = 0;
  try {
    scheduleHourUtc = (await jobs.get("resident-agent"))?.scheduleHourUtc ?? 0;
  } catch {
    scheduleHourUtc = 0;
  }

  const forumBrief = await runForumBriefTrigger(runner, briefs, scheduleHourUtc, now);
  const weeklyPlan = await runWeeklyPlanTrigger(runner, briefs, scheduleHourUtc, now);
  const decomposeAssignment = await runDecomposeAssignmentTriggers(env.DB, runner, briefs, now);
  return { forumBrief, weeklyPlan, decomposeAssignment };
}

async function runForumBriefTrigger(
  runner: PlaybookRunner,
  briefs: BriefStore,
  scheduleHourUtc: number,
  now: Date,
): Promise<PlaybookTriggerStatus> {
  if (now.getUTCHours() < scheduleHourUtc) {
    return { status: "not_due" };
  }
  const id = `forum-brief:${dayKey(now)}`;
  if (await briefs.exists(id)) {
    return { status: "already_done" };
  }
  const previous = await briefs.latestByKind("forum-brief");
  const subject = previous?.createdAt ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return runPlaybookAndFile(runner, briefs, "forum-brief", { id, kind: "forum-brief", subject }, now);
}

async function runWeeklyPlanTrigger(
  runner: PlaybookRunner,
  briefs: BriefStore,
  scheduleHourUtc: number,
  now: Date,
): Promise<PlaybookTriggerStatus> {
  if (now.getUTCDay() !== 1 || now.getUTCHours() < scheduleHourUtc) {
    return { status: "not_due" };
  }
  const week = isoWeek(now);
  const id = `weekly-plan:${week}`;
  if (await briefs.exists(id)) {
    return { status: "already_done" };
  }
  return runPlaybookAndFile(runner, briefs, "weekly-plan", { id, kind: "weekly-plan", subject: week }, now);
}

async function runDecomposeAssignmentTriggers(
  db: D1Database,
  runner: PlaybookRunner,
  briefs: BriefStore,
  now: Date,
): Promise<PlaybookCycleSummary["decomposeAssignment"]> {
  const counts = { attempted: 0, completed: 0, skipped: 0, failed: 0 };
  let candidates: Array<{ source: string; itemId: string }>;
  try {
    candidates = await findDecomposeCandidates(db, now);
  } catch (error) {
    console.error(JSON.stringify({ event: "decompose_candidates_failed", message: errorMessage(error) }));
    return counts;
  }

  let plansTableWarned = false;
  for (const candidate of candidates) {
    if (counts.attempted >= DECOMPOSE_ASSIGNMENT_CAP) {
      break;
    }
    const subject = `${candidate.source} ${candidate.itemId}`;
    const id = `assignment-plan:${candidate.source}:${candidate.itemId}`;
    if (await briefs.exists(id)) {
      continue;
    }
    const hasPlan = await hasAssignmentPlan(db, subject, () => {
      if (!plansTableWarned) {
        plansTableWarned = true;
        console.error(JSON.stringify({ event: "plans_table_unavailable" }));
      }
    });
    if (hasPlan) {
      continue;
    }
    counts.attempted += 1;
    const outcome = await runPlaybookAndFile(
      runner,
      briefs,
      "decompose-assignment",
      { id, kind: "assignment-plan", subject },
      now,
    );
    if (outcome.status === "completed") {
      counts.completed += 1;
    } else if (outcome.status === "failed") {
      counts.failed += 1;
    } else {
      counts.skipped += 1;
    }
  }
  return counts;
}

// Runs one playbook and turns its result into a brief (or a log line): completed
// becomes a brief; nothing_to_report and other skip reasons write nothing;
// budget_exhausted also writes one shared per-day notice; failed only logs counts
// and a code, never the playbook's prompt or partial output.
async function runPlaybookAndFile(
  runner: PlaybookRunner,
  briefs: BriefStore,
  playbook: PlaybookId,
  brief: { id: string; kind: BriefKind; subject: string },
  now: Date,
): Promise<PlaybookTriggerStatus> {
  let result: PlaybookRunResult;
  try {
    result = await runner.run({ playbook, subject: brief.subject });
  } catch (error) {
    console.error(JSON.stringify({ event: "playbook_failed", playbook, message: errorMessage(error) }));
    return { status: "failed", code: "runner_failed" };
  }

  if (result.status === "completed") {
    await briefs.insert({
      id: brief.id,
      kind: brief.kind,
      subject: brief.subject,
      title: result.title,
      body: result.text,
      createdAt: now.toISOString(),
    });
    console.log(JSON.stringify({ event: "playbook_completed", playbook }));
    return { status: "completed" };
  }
  if (result.status === "skipped") {
    if (result.reason === "budget_exhausted") {
      await briefs.insert({
        id: `budget:${dayKey(now)}`,
        kind: brief.kind,
        subject: "budget",
        title: "unicorn playbook budget exhausted",
        body: "The resident-agent monthly token cap is exhausted, so scheduled playbooks are paused today. Raise the cap with configure_agent_job or wait for next month.",
        createdAt: now.toISOString(),
      });
    }
    console.log(JSON.stringify({ event: "playbook_skipped", playbook, reason: result.reason }));
    return { status: "skipped", reason: result.reason };
  }
  console.error(JSON.stringify({ event: "playbook_failed", playbook, code: result.code }));
  return { status: "failed", code: result.code };
}

interface DecomposeCandidateRow {
  source: string;
  item_id: string;
}

// Items with a `has-deadline` temporal facet due within 7 days, not archived.
// Submission status is checked separately (a second facet, possibly absent).
async function findDecomposeCandidates(db: D1Database, now: Date): Promise<Array<{ source: string; itemId: string }>> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT i.source, i.item_id
       FROM items i
       JOIN facets f ON f.source = i.source AND f.item_id = i.item_id
       JOIN json_each(f.capabilities_json) binding
       WHERE i.archived_at IS NULL
         AND json_extract(binding.value, '$.name') = 'has-deadline'
         AND json_extract(binding.value, '$.primitive') = 'temporal'
         AND julianday(
               json_extract(f.data_json, '$.' || json_extract(binding.value, '$.field'))
             ) BETWEEN julianday(?) AND julianday(?, '+7 days')
       ORDER BY i.source, i.item_id`,
    )
    .bind(now.toISOString(), now.toISOString())
    .all<DecomposeCandidateRow>();

  const eligible: Array<{ source: string; itemId: string }> = [];
  for (const row of rows.results) {
    const status = await getSubmissionStatus(db, row.source, row.item_id);
    if (status && SUBMITTED_STATUSES.has(status)) {
      continue;
    }
    eligible.push({ source: row.source, itemId: row.item_id });
  }
  return eligible;
}

async function getSubmissionStatus(db: D1Database, source: string, itemId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT json_extract(f.data_json, '$.' || json_extract(binding.value, '$.field')) AS status
       FROM facets f
       JOIN json_each(f.capabilities_json) binding
       WHERE f.source = ? AND f.item_id = ?
         AND json_extract(binding.value, '$.name') = 'has-submission-status'
       LIMIT 1`,
    )
    .bind(source, itemId)
    .first<{ status: string | null }>();
  return row?.status ?? null;
}

// The `plans` table lands with feat/brain's migration 0009; until merged (and if a
// future migration ever drops it) this degrades to "no plan yet" rather than
// failing the whole trigger, logging the first occurrence per cycle only.
async function hasAssignmentPlan(db: D1Database, subject: string, onUnavailable: () => void): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT 1 FROM plans WHERE kind = 'assignment' AND subject = ? LIMIT 1").bind(subject).first();
    return row !== null;
  } catch {
    onUnavailable();
    return false;
  }
}

// ISO 8601 week (e.g. "2026-W38"), Monday-start with the Thursday rule for the
// year boundary.
function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
