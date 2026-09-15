import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/index";
import { runCycle, type Env } from "../src/runtime/cycle";
import type { PlaybookRunInput, PlaybookRunner, PlaybookRunResult } from "../src/agent/playbook-runner";

describe("Scheduler", () => {
  it("starts and reports a persistent alarm", async () => {
    const storage = {
      setAlarm: vi.fn().mockResolvedValue(undefined),
      getAlarm: vi.fn().mockResolvedValue(1_800_000_000_000),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    };
    const scheduler = new Scheduler({ storage } as unknown as DurableObjectState, {} as never);

    const start = await scheduler.fetch(new Request("https://scheduler/start", { method: "POST" }));
    const status = await scheduler.fetch(new Request("https://scheduler/status"));

    expect(start.status).toBe(200);
    expect(storage.setAlarm).toHaveBeenCalledOnce();
    await expect(status.json()).resolves.toEqual({ scheduled: true, nextAlarm: 1_800_000_000_000 });
  });
});

interface BriefRow {
  id: string;
  kind: string;
  subject: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

interface World {
  scheduleHourUtc: number;
  briefs: BriefRow[];
  candidates: Array<{ source: string; itemId: string; submissionStatus?: string }>;
  plans: string[];
  plansTableMissing?: boolean;
}

function fakeRunner(handler: (input: PlaybookRunInput) => PlaybookRunResult): PlaybookRunner & { calls: PlaybookRunInput[] } {
  const calls: PlaybookRunInput[] = [];
  return {
    calls,
    async run(input: PlaybookRunInput): Promise<PlaybookRunResult> {
      calls.push(input);
      return handler(input);
    },
  };
}

// A world-scoped in-memory D1 double covering exactly the statements a scheduled
// cycle issues with no plugins/jobs configured, plus the tables the playbook
// triggers read and write (agent_jobs' resident-agent row, items/facets for
// decompose candidates, plans, and briefs).
function fakeEnv(world: World): Env {
  const db = {
    prepare(sql: string) {
      const binder = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args;
          return this;
        },
        async run() {
          if (sql.startsWith("INSERT INTO briefs")) {
            const [id, kind, subject, title, body, createdAt] = this.args as string[];
            if (world.briefs.some((row) => row.id === id)) {
              return { meta: { changes: 0 } };
            }
            world.briefs.push({ id, kind, subject, title, body, created_at: createdAt, read_at: null });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first<T>() {
          if (sql.startsWith("SELECT value_json FROM settings")) {
            return null as unknown as T; // default settings
          }
          if (sql.includes("FROM agent_jobs j")) {
            const id = this.args[this.args.length - 1];
            if (id !== "resident-agent") {
              return null as unknown as T; // triage / daily-digest: disabled
            }
            return {
              id: "resident-agent",
              enabled: 0,
              model: "gpt-5-mini",
              monthly_token_cap: 200000,
              schedule_hour_utc: world.scheduleHourUtc,
              credential_preference: "byok",
              current_month_usage: 0,
              last_run_at: null,
            } as unknown as T;
          }
          if (sql.startsWith("SELECT enabled FROM agent_jobs")) {
            return null as unknown as T; // isJobEnabled("triage") -> false
          }
          if (sql.startsWith("SELECT 1 FROM briefs WHERE id = ?")) {
            const [id] = this.args as [string];
            return (world.briefs.some((row) => row.id === id) ? { 1: 1 } : null) as unknown as T;
          }
          if (sql.startsWith("SELECT * FROM briefs WHERE id = ?")) {
            const [id] = this.args as [string];
            const row = world.briefs.find((candidate) => candidate.id === id);
            return (row ?? null) as unknown as T;
          }
          if (sql.startsWith("SELECT * FROM briefs WHERE kind = ?")) {
            const [kind] = this.args as [string];
            const match = world.briefs
              .filter((row) => row.kind === kind)
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
            return (match ?? null) as unknown as T;
          }
          if (sql.includes("has-submission-status")) {
            const [source, itemId] = this.args as [string, string];
            const candidate = world.candidates.find((c) => c.source === source && c.itemId === itemId);
            return { status: candidate?.submissionStatus ?? null } as unknown as T;
          }
          if (sql.startsWith("SELECT 1 FROM plans")) {
            if (world.plansTableMissing) {
              throw new Error("no such table: plans");
            }
            const [subject] = this.args as [string];
            return (world.plans.includes(subject) ? { 1: 1 } : null) as unknown as T;
          }
          return null as unknown as T;
        },
        async all<T>() {
          if (sql.includes("has-deadline")) {
            return { results: world.candidates.map((c) => ({ source: c.source, item_id: c.itemId })) as unknown as T[] };
          }
          return { results: [] as T[] };
        },
      };
      return binder;
    },
  } as unknown as D1Database;

  return {
    ADMIN_TOKEN: "admin-secret",
    MCP_TOKEN: "mcp-secret",
    AI_BASE_URL: "https://api.openai.com/v1",
    MOODLE_BASE_URL: "https://learning.example.edu",
    DB: db,
    AGENT_SESSIONS: {} as unknown as DurableObjectNamespace,
    SCHEDULER: {} as unknown as DurableObjectNamespace,
  } as unknown as Env;
}

const COMPLETED = (title: string, text: string): PlaybookRunResult => ({
  status: "completed",
  title,
  text,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

describe("scheduled playbook triggers", () => {
  it("skips forum-brief before the schedule hour", async () => {
    const world: World = { scheduleHourUtc: 12, briefs: [], candidates: [], plans: [] };
    const runner = fakeRunner(() => COMPLETED("t", "b"));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-21T01:00:00.000Z")); // a Tuesday, before hour 12
      const cycle = await runCycle(fakeEnv(world), true, { playbookRunner: runner });

      expect(cycle.playbooks.forumBrief).toEqual({ status: "not_due" });
      expect(runner.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs forum-brief once at/after the schedule hour, using 7 days ago as the subject on first run", async () => {
    const world: World = { scheduleHourUtc: 0, briefs: [], candidates: [], plans: [] };
    const runner = fakeRunner((input) => COMPLETED(`brief for ${input.playbook}`, "forum summary"));
    vi.useFakeTimers();
    try {
      const now = new Date("2026-07-19T01:00:00.000Z"); // a Sunday
      vi.setSystemTime(now);

      const cycle = await runCycle(fakeEnv(world), true, { playbookRunner: runner });

      expect(cycle.playbooks.forumBrief).toEqual({ status: "completed" });
      const forumCall = runner.calls.find((call) => call.playbook === "forum-brief");
      expect(forumCall?.subject).toBe(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
      expect(world.briefs.find((row) => row.id === "forum-brief:2026-07-19")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-run forum-brief the same day (idempotent on the brief id)", async () => {
    const world: World = { scheduleHourUtc: 0, briefs: [], candidates: [], plans: [] };
    const runner = fakeRunner(() => COMPLETED("t", "forum summary"));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-19T01:00:00.000Z"));
      await runCycle(fakeEnv(world), true, { playbookRunner: runner });
      const secondCycle = await runCycle(fakeEnv(world), true, { playbookRunner: runner });

      expect(secondCycle.playbooks.forumBrief).toEqual({ status: "already_done" });
      expect(runner.calls.filter((call) => call.playbook === "forum-brief")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only runs weekly-plan on Monday at/after the schedule hour, keyed by ISO week", async () => {
    const world: World = { scheduleHourUtc: 0, briefs: [], candidates: [], plans: [] };
    const runner = fakeRunner((input) => COMPLETED(`brief for ${input.playbook}`, "the plan"));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-20T00:30:00.000Z")); // a Monday
      const cycle = await runCycle(fakeEnv(world), true, { playbookRunner: runner });

      expect(cycle.playbooks.weeklyPlan).toEqual({ status: "completed" });
      const weeklyCall = runner.calls.find((call) => call.playbook === "weekly-plan");
      expect(weeklyCall?.subject).toMatch(/^\d{4}-W\d{2}$/);
      expect(world.briefs.find((row) => row.id.startsWith("weekly-plan:"))).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips weekly-plan on a non-Monday", async () => {
    const world: World = { scheduleHourUtc: 0, briefs: [], candidates: [], plans: [] };
    const runner = fakeRunner(() => COMPLETED("t", "b"));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z")); // a Tuesday
      const cycle = await runCycle(fakeEnv(world), true, { playbookRunner: runner });

      expect(cycle.playbooks.weeklyPlan).toEqual({ status: "not_due" });
      expect(runner.calls.some((call) => call.playbook === "weekly-plan")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("decomposes eligible assignments capped at 3 per cycle, skipping submitted/graded and already-planned ones", async () => {
    const world: World = {
      scheduleHourUtc: 0,
      briefs: [{ id: "assignment-plan:campus-moodle:already-briefed", kind: "assignment-plan", subject: "x", title: "t", body: "b", created_at: "2026-07-01T00:00:00.000Z", read_at: null }],
      // graded/already-briefed/already-planned are filtered or skipped WITHOUT
      // consuming the attempt budget, so they are ordered first to prove that,
      // leaving a1..a3 to actually run and a4 to be excluded by the cap.
      candidates: [
        { source: "campus-moodle", itemId: "graded", submissionStatus: "graded" },
        { source: "campus-moodle", itemId: "already-briefed" },
        { source: "campus-moodle", itemId: "already-planned" },
        { source: "campus-moodle", itemId: "a1" },
        { source: "campus-moodle", itemId: "a2" },
        { source: "campus-moodle", itemId: "a3" },
        { source: "campus-moodle", itemId: "a4" },
      ],
      plans: ["campus-moodle:already-planned"],
    };
    const runner = fakeRunner((input) => COMPLETED("plan", `plan for ${input.subject}`));

    const cycle = await runCycle(fakeEnv(world), true, { playbookRunner: runner });

    expect(cycle.playbooks.decomposeAssignment).toEqual({ attempted: 3, completed: 3, skipped: 0, failed: 0 });
    const subjects = runner.calls.filter((call) => call.playbook === "decompose-assignment").map((call) => call.subject);
    expect(subjects).toEqual(["campus-moodle:a1", "campus-moodle:a2", "campus-moodle:a3"]);
  });

  it("degrades to no-plans when the plans table is unavailable, rather than failing the trigger", async () => {
    const world: World = {
      scheduleHourUtc: 0,
      briefs: [],
      candidates: [{ source: "campus-moodle", itemId: "a1" }],
      plans: [],
      plansTableMissing: true,
    };
    const runner = fakeRunner(() => COMPLETED("plan", "text"));

    const cycle = await runCycle(fakeEnv(world), true, { playbookRunner: runner });

    expect(cycle.playbooks.decomposeAssignment).toEqual({ attempted: 1, completed: 1, skipped: 0, failed: 0 });
  });

  it("writes one shared budget-exhausted brief per day and does not duplicate it", async () => {
    const world: World = { scheduleHourUtc: 0, briefs: [], candidates: [], plans: [] };
    const runner = fakeRunner((input): PlaybookRunResult =>
      input.playbook === "forum-brief" ? { status: "skipped", reason: "budget_exhausted" } : { status: "skipped", reason: "nothing_to_report" },
    );

    const cycle = await runCycle(fakeEnv(world), true, { playbookRunner: runner });

    expect(cycle.playbooks.forumBrief).toEqual({ status: "skipped", reason: "budget_exhausted" });
    const budgetBriefs = world.briefs.filter((row) => row.id.startsWith("budget:"));
    expect(budgetBriefs).toHaveLength(1);
  });

  it("writes nothing for skipped/nothing_to_report", async () => {
    const world: World = { scheduleHourUtc: 0, briefs: [], candidates: [], plans: [] };
    const runner = fakeRunner((): PlaybookRunResult => ({ status: "skipped", reason: "nothing_to_report" }));

    const cycle = await runCycle(fakeEnv(world), true, { playbookRunner: runner });

    expect(cycle.playbooks.forumBrief).toEqual({ status: "skipped", reason: "nothing_to_report" });
    expect(world.briefs).toHaveLength(0);
  });

  it("logs a failed playbook without writing a brief", async () => {
    const world: World = { scheduleHourUtc: 0, briefs: [], candidates: [], plans: [] };
    const runner = fakeRunner((): PlaybookRunResult => ({ status: "failed", code: "provider_failed" }));

    const cycle = await runCycle(fakeEnv(world), true, { playbookRunner: runner });

    expect(cycle.playbooks.forumBrief).toEqual({ status: "failed", code: "provider_failed" });
    expect(world.briefs).toHaveLength(0);
  });
});
