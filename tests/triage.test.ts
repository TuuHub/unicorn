import { describe, expect, it, vi } from "vitest";
import { classify, TriageRunner, type TriageDataSource, type MemoryReader } from "../src/jobs/triage";
import type { JobStore, TextGenerator } from "../src/jobs/daily-digest";
import type { ItemEvent } from "../src/kernel/types";

const NOW = new Date("2026-07-19T00:00:00.000Z");

describe("classify (deterministic reflexes)", () => {
  it("always flags a moved deadline as important without a model", () => {
    const event: ItemEvent = {
      id: "e1",
      type: "capability.changed",
      source: "campus-moodle",
      itemId: "assessment:1",
      createdAt: NOW.toISOString(),
      primitive: "temporal",
      capability: "has-deadline",
      before: "2026-07-20T00:00:00.000Z",
      after: "2026-07-25T00:00:00.000Z",
    };
    expect(classify(event, NOW).importance).toBe("important");
  });

  it("ignores a raw-only revision", () => {
    const event: ItemEvent = {
      id: "e2",
      type: "item.updated",
      source: "campus-ed",
      itemId: "thread:2",
      createdAt: NOW.toISOString(),
      changedFields: ["raw"],
    };
    expect(classify(event, NOW).importance).toBe("ignore");
  });

  it("leaves item.created ambiguous at the classify stage (the runner promotes imminent deadlines)", () => {
    const event: ItemEvent = {
      id: "e3",
      type: "item.created",
      source: "campus-moodle",
      itemId: "assessment:3",
      createdAt: NOW.toISOString(),
    };
    expect(classify(event, NOW).importance).toBe("ambiguous");
  });

  it("leaves an ordinary new item ambiguous for the model", () => {
    const event: ItemEvent = {
      id: "e4",
      type: "item.created",
      source: "campus-ed",
      itemId: "thread:4",
      createdAt: NOW.toISOString(),
    };
    expect(classify(event, NOW).importance).toBe("ambiguous");
  });
});

describe("TriageRunner", () => {
  it("notifies for deterministic-important changes without calling the model", async () => {
    const store = jobStore();
    const notify = vi.fn().mockResolvedValue(undefined);
    const generator = { generate: vi.fn() } as unknown as TextGenerator;
    const runner = new TriageRunner(store, dataSource([temporalChange()]), memory(""), generator, notify);

    const result = await runner.run(NOW);

    expect(result.status).toBe("completed");
    expect(notify).toHaveBeenCalledOnce();
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it("keeps ambiguous events when there is no model budget rather than dropping them", async () => {
    const store = jobStore({ monthlyUsage: 199_999, monthlyTokenCap: 200_000 });
    const notify = vi.fn().mockResolvedValue(undefined);
    const generator = { generate: vi.fn() } as unknown as TextGenerator;
    const runner = new TriageRunner(store, dataSource([newThread()]), memory(""), generator, notify);

    const result = await runner.run(NOW);

    expect(result.status).toBe("completed");
    expect(generator.generate).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("suppresses events the model judges unimportant", async () => {
    const store = jobStore();
    const notify = vi.fn().mockResolvedValue(undefined);
    const generator = {
      generate: vi.fn().mockResolvedValue({
        text: "thread:4: ignore",
        usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      }),
    } as unknown as TextGenerator;
    const runner = new TriageRunner(store, dataSource([newThread()]), memory(""), generator, notify);

    const result = await runner.run(NOW);

    expect(result.status).toBe("completed");
    expect(notify).not.toHaveBeenCalled();
  });

  it("promotes a new item whose item deadline is within 7 days without the model", async () => {
    const store = jobStore();
    const notify = vi.fn().mockResolvedValue(undefined);
    const generator = { generate: vi.fn() } as unknown as TextGenerator;
    const data: TriageDataSource = {
      listRecentEvents: vi.fn().mockResolvedValue([newAssessment()]),
      describeItems: vi.fn().mockResolvedValue([
        { source: "campus-moodle", itemId: "assessment:3", title: "Assignment 3", kind: "assessment", dueAt: "2026-07-22T00:00:00.000Z" },
      ]),
    };
    const runner = new TriageRunner(store, data, memory(""), generator, notify);

    const result = await runner.run(NOW);

    expect(result.status).toBe("completed");
    expect(notify).toHaveBeenCalledOnce();
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it("does not run when disabled", async () => {
    const store = jobStore({ enabled: false });
    const runner = new TriageRunner(store, dataSource([temporalChange()]), memory(""), null, vi.fn());
    await expect(runner.run(NOW)).resolves.toEqual({ status: "disabled" });
  });
});

function temporalChange(): ItemEvent {
  return {
    id: "e1",
    type: "capability.changed",
    source: "campus-moodle",
    itemId: "assessment:1",
    createdAt: "2026-07-18T12:00:00.000Z",
    primitive: "temporal",
    capability: "has-deadline",
    after: "2026-07-25T00:00:00.000Z",
  };
}

function newThread(): ItemEvent {
  return {
    id: "e4",
    type: "item.created",
    source: "campus-ed",
    itemId: "thread:4",
    createdAt: "2026-07-18T12:00:00.000Z",
  };
}

function newAssessment(): ItemEvent {
  return {
    id: "e3",
    type: "item.created",
    source: "campus-moodle",
    itemId: "assessment:3",
    createdAt: "2026-07-18T12:00:00.000Z",
  };
}

function dataSource(events: ItemEvent[]): TriageDataSource {
  return {
    listRecentEvents: vi.fn().mockResolvedValue(events),
    describeItems: vi.fn().mockImplementation(async (keys: Array<{ source: string; itemId: string }>) =>
      keys.map((key) => ({ source: key.source, itemId: key.itemId, title: `Title ${key.itemId}`, kind: "assessment" })),
    ),
  };
}

function memory(content: string): MemoryReader {
  return { read: vi.fn().mockResolvedValue(content) };
}

function jobStore(overrides: { enabled?: boolean; monthlyUsage?: number; monthlyTokenCap?: number } = {}): JobStore &
  Record<string, ReturnType<typeof vi.fn>> {
  return {
    get: vi.fn().mockResolvedValue({
      id: "triage",
      enabled: overrides.enabled ?? true,
      model: "gpt-5-mini",
      monthlyTokenCap: overrides.monthlyTokenCap ?? 200_000,
      scheduleHourUtc: 0,
      credentialPreference: "byok",
      currentMonthUsage: overrides.monthlyUsage ?? 0,
      projectedMonthlyTokens: 0,
      lastRunAt: null,
    }),
    getMonthlyUsage: vi.fn().mockResolvedValue(overrides.monthlyUsage ?? 0),
    recordRun: vi.fn().mockResolvedValue(undefined),
    setEnabled: vi.fn().mockResolvedValue(undefined),
  } as JobStore & Record<string, ReturnType<typeof vi.fn>>;
}
