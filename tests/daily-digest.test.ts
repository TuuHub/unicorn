import { describe, expect, it, vi } from "vitest";
import {
  DailyDigestRunner,
  type DigestDataSource,
  type JobStore,
  type TextGenerator,
} from "../src/jobs/daily-digest";

describe("DailyDigestRunner", () => {
  it("does not call the model after the monthly hard cap is exhausted", async () => {
    const store = jobStore({ monthlyUsage: 10_000, monthlyTokenCap: 10_000 });
    const generator = textGenerator();
    const runner = new DailyDigestRunner(store, dataSource(), generator);

    const result = await runner.run(new Date("2026-07-13T00:00:00.000Z"));

    expect(result).toEqual({ status: "budget_exhausted" });
    expect(generator.generate).not.toHaveBeenCalled();
    expect(store.setEnabled).toHaveBeenCalledWith("daily-digest", false);
  });

  it("does not call the model when the remaining budget cannot cover the prompt", async () => {
    const store = jobStore({ monthlyUsage: 9_900, monthlyTokenCap: 10_000 });
    const generator = textGenerator();
    const runner = new DailyDigestRunner(store, dataSource(), generator);

    const result = await runner.run(new Date("2026-07-13T00:00:00.000Z"));

    expect(result).toEqual({ status: "budget_exhausted" });
    expect(generator.generate).not.toHaveBeenCalled();
    expect(store.setEnabled).toHaveBeenCalledWith("daily-digest", false);
  });

  it("waits until the configured UTC schedule hour", async () => {
    const store = jobStore({ monthlyUsage: 0, monthlyTokenCap: 10_000, scheduleHourUtc: 8 });
    const generator = textGenerator();
    const runner = new DailyDigestRunner(store, dataSource(), generator);

    const result = await runner.run(new Date("2026-07-13T07:59:00.000Z"));

    expect(result).toEqual({ status: "not_due" });
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it("records actual usage and the generated digest", async () => {
    const store = jobStore({ monthlyUsage: 200, monthlyTokenCap: 10_000 });
    const generator = textGenerator({
      text: "Assignment 3 is due next week.",
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    const runner = new DailyDigestRunner(store, dataSource(), generator);

    const result = await runner.run(new Date("2026-07-13T00:00:00.000Z"));

    expect(result).toEqual({
      status: "completed",
      text: "Assignment 3 is due next week.",
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    expect(store.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "daily-digest",
        status: "completed",
        output: "Assignment 3 is due next week.",
        totalTokens: 150,
      }),
    );
  });
});

function jobStore(overrides: {
  monthlyUsage: number;
  monthlyTokenCap: number;
  scheduleHourUtc?: number;
}): JobStore & Record<string, ReturnType<typeof vi.fn>> {
  return {
    get: vi.fn().mockResolvedValue({
      id: "daily-digest",
      enabled: true,
      model: "gpt-5-mini",
      monthlyTokenCap: overrides.monthlyTokenCap,
      scheduleHourUtc: overrides.scheduleHourUtc ?? 0,
      credentialPreference: "byok",
      currentMonthUsage: overrides.monthlyUsage,
      projectedMonthlyTokens: overrides.monthlyUsage,
      lastRunAt: null,
    }),
    getMonthlyUsage: vi.fn().mockResolvedValue(overrides.monthlyUsage),
    recordRun: vi.fn().mockResolvedValue(undefined),
    setEnabled: vi.fn().mockResolvedValue(undefined),
  } as JobStore & Record<string, ReturnType<typeof vi.fn>>;
}

function dataSource(): DigestDataSource {
  return {
    listRecentEvents: vi.fn().mockResolvedValue([
      { type: "item.created", source: "campus-moodle", itemId: "assessment:99", createdAt: "2026-07-12T10:00:00.000Z" },
    ]),
    listUpcoming: vi.fn().mockResolvedValue([
      { title: "Assignment 3", dueAt: "2026-07-20T06:00:00.000Z", source: "campus-moodle" },
    ]),
  };
}

function textGenerator(result = { text: "unused", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }): TextGenerator & { generate: ReturnType<typeof vi.fn> } {
  return { generate: vi.fn().mockResolvedValue(result) };
}
