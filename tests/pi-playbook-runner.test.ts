import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { PiPlaybookRunner } from "../src/agent/pi-playbook-runner";
import type { PiModelRuntime } from "../src/agent/pi-model";
import type { AgentToolRepository } from "../src/agent/tools";
import type { JobRunInput, JobStore } from "../src/jobs/daily-digest";

function enabledJobStore(currentMonthUsage = 0) {
  const runs: JobRunInput[] = [];
  const jobs = {
    get: vi.fn().mockResolvedValue({
      id: "resident-agent",
      enabled: true,
      model: "faux-1",
      monthlyTokenCap: 10_000,
      scheduleHourUtc: 0,
      credentialPreference: "byok",
      currentMonthUsage,
      projectedMonthlyTokens: currentMonthUsage,
      lastRunAt: null,
    }),
    getMonthlyUsage: vi.fn(),
    setEnabled: vi.fn(),
    recordRun: vi.fn(async (run: JobRunInput) => {
      runs.push(run);
    }),
  } as unknown as JobStore;
  return { jobs, runs };
}

function fauxRuntime(responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]) {
  const faux = createFauxCore({});
  faux.setResponses(responses);
  const runtime: PiModelRuntime = {
    resolve: () => ({ model: faux.getModel(), stream: faux.streamSimple }) as ReturnType<PiModelRuntime["resolve"]>,
  };
  return { faux, runtime };
}

function repository(overrides: Partial<AgentToolRepository> = {}): AgentToolRepository {
  return {
    listCourses: vi.fn().mockResolvedValue([]),
    getCourseOverview: vi.fn(),
    searchItems: vi.fn().mockResolvedValue([]),
    find: vi.fn().mockResolvedValue(null),
    listUpcoming: vi.fn().mockResolvedValue([]),
    listEvents: vi.fn().mockResolvedValue([]),
    listStaffPosts: vi.fn().mockResolvedValue([]),
    listMemory: vi.fn().mockResolvedValue([]),
    getSyncStatus: vi.fn().mockResolvedValue(null),
    getPlan: vi.fn().mockResolvedValue(null),
    savePlan: vi.fn(),
    remember: vi.fn(),
    ...overrides,
  };
}

describe("PiPlaybookRunner", () => {
  it("returns a completed brief with a friendly title", async () => {
    const { jobs, runs } = enabledJobStore();
    const { faux, runtime } = fauxRuntime([fauxAssistantMessage("FIT2004: staff pinned a new clarification.")]);
    const runner = new PiPlaybookRunner({
      jobs,
      repository: repository(),
      runtime,
      now: () => new Date("2026-09-16T01:00:00.000Z"),
    });

    const result = await runner.run({ playbook: "forum-brief" });

    expect(result).toEqual({
      status: "completed",
      title: "Forum brief · 16 Sep",
      text: "FIT2004: staff pinned a new clarification.",
      usage: expect.objectContaining({ totalTokens: expect.any(Number) }),
    });
    expect(faux.state.callCount).toBe(1);
    expect(runs).toEqual([expect.objectContaining({ jobId: "resident-agent", status: "completed" })]);
  });

  it("skips as nothing_to_report when the model finds nothing", async () => {
    const { jobs, runs } = enabledJobStore();
    const { runtime } = fauxRuntime([fauxAssistantMessage("NOTHING_TO_REPORT")]);
    const runner = new PiPlaybookRunner({ jobs, repository: repository(), runtime });

    const result = await runner.run({ playbook: "forum-brief" });

    expect(result).toEqual({ status: "skipped", reason: "nothing_to_report" });
    expect(runs).toEqual([expect.objectContaining({ status: "no_changes" })]);
  });

  it("skips before inference when the monthly budget is exhausted", async () => {
    const { jobs } = enabledJobStore(10_000);
    const { faux, runtime } = fauxRuntime([fauxAssistantMessage("must not run")]);
    const runner = new PiPlaybookRunner({ jobs, repository: repository(), runtime });

    const result = await runner.run({ playbook: "weekly-plan", subject: "2026-W38" });

    expect(result).toEqual({ status: "skipped", reason: "budget_exhausted" });
    expect(faux.state.callCount).toBe(0);
  });

  it("skips when the resident-agent job is disabled", async () => {
    const jobs = { get: vi.fn().mockResolvedValue({ id: "resident-agent", enabled: false }), recordRun: vi.fn() } as unknown as JobStore;
    const { faux, runtime } = fauxRuntime([fauxAssistantMessage("must not run")]);
    const runner = new PiPlaybookRunner({ jobs, repository: repository(), runtime });

    const result = await runner.run({ playbook: "decompose-assignment", subject: "campus-moodle:assessment:1" });

    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(faux.state.callCount).toBe(0);
  });

  it("skips when no model runtime is configured", async () => {
    const { jobs } = enabledJobStore();
    const runner = new PiPlaybookRunner({ jobs, repository: repository(), runtime: null });

    const result = await runner.run({ playbook: "forum-brief" });

    expect(result).toEqual({ status: "skipped", reason: "not_configured" });
  });

  it("reports a failure code and records the failed run when the provider errors", async () => {
    const { jobs, runs } = enabledJobStore();
    const { runtime } = fauxRuntime([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider unavailable" }),
    ]);
    const runner = new PiPlaybookRunner({ jobs, repository: repository(), runtime });

    const result = await runner.run({ playbook: "forum-brief" });

    expect(result).toEqual({ status: "failed", code: "provider_failed" });
    expect(runs).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("builds an instruction from the playbook procedure, subject, and context", async () => {
    const { jobs } = enabledJobStore();
    const seenPrompts: string[] = [];
    const { runtime } = fauxRuntime([
      (context) => {
        const last = context.messages.at(-1);
        seenPrompts.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
        return fauxAssistantMessage("Plan saved.");
      },
    ]);
    const runner = new PiPlaybookRunner({ jobs, repository: repository(), runtime });

    await runner.run({
      playbook: "decompose-assignment",
      subject: "campus-moodle:assessment:123",
      context: "The student asked for extra detail on testing.",
    });

    expect(seenPrompts[0]).toContain("Decompose assignment");
    expect(seenPrompts[0]).toContain("campus-moodle:assessment:123");
    expect(seenPrompts[0]).toContain("The student asked for extra detail on testing.");
    expect(seenPrompts[0]).toContain("NOTHING_TO_REPORT");
  });
});
