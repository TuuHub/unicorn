import { describe, expect, it, vi } from "vitest";
import { CONSOLIDATION_THRESHOLD, MemoryConsolidator } from "../src/jobs/memory-consolidation";
import type { JobStore, TextGenerator } from "../src/jobs/daily-digest";
import { MemoryConflictError, type MemoryNote, type MemoryStore } from "../src/memory";

const NOW = new Date("2026-07-19T00:00:00.000Z");

// ~3500 tokens of Latin text — over the 3200-token consolidation threshold.
const BLOATED = "The FIT2099 weekly quizzes do not count toward the final grade. ".repeat(220);

describe("MemoryConsolidator", () => {
  it("does nothing while notes are under the threshold", async () => {
    const generator = { generate: vi.fn() } as unknown as TextGenerator;
    const consolidator = new MemoryConsolidator(memoryStore([note("preferences", "short note")]), jobStore(), generator);

    await expect(consolidator.run(NOW)).resolves.toEqual({ status: "not_needed" });
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it("compresses bloated notes through the model and books tokens to triage", async () => {
    const store = memoryStore([note("preferences", BLOATED)]);
    const jobs = jobStore();
    const generator = {
      generate: vi.fn().mockResolvedValue({
        text: "## preferences\nFIT2099 quizzes don't count.",
        usage: { inputTokens: 3600, outputTokens: 20, totalTokens: 3620 },
      }),
    } as unknown as TextGenerator;
    const consolidator = new MemoryConsolidator(store, jobs, generator);

    const result = await consolidator.run(NOW);

    expect(result.status).toBe("completed");
    expect(store.save).toHaveBeenCalledWith("preferences", "FIT2099 quizzes don't count.", "2026-07-01T00:00:00.000Z");
    const run = (jobs.recordRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(run.jobId).toBe("triage");
    expect(run.totalTokens).toBe(3620);
    // The triage event watermark must not move.
    expect(run.watermark).toBe("2026-07-18T23:00:00.000Z");
  });

  it("keeps the original when the model reply would grow a domain or drops it", async () => {
    const store = memoryStore([note("preferences", BLOATED)]);
    const generator = {
      generate: vi.fn().mockResolvedValue({
        // Missing the ## preferences section entirely.
        text: "I could not shorten these notes.",
        usage: { inputTokens: 3600, outputTokens: 12, totalTokens: 3612 },
      }),
    } as unknown as TextGenerator;
    const consolidator = new MemoryConsolidator(store, jobStore(), generator);

    const result = await consolidator.run(NOW);

    expect(result.status).toBe("failed");
    expect(store.save).not.toHaveBeenCalled();
  });

  it("lets a concurrent user edit win without failing the pass", async () => {
    const store = memoryStore([note("preferences", BLOATED)]);
    (store.save as ReturnType<typeof vi.fn>).mockRejectedValue(new MemoryConflictError("2026-07-19T00:00:01.000Z"));
    const generator = {
      generate: vi.fn().mockResolvedValue({
        text: "## preferences\nFIT2099 quizzes don't count.",
        usage: { inputTokens: 3600, outputTokens: 20, totalTokens: 3620 },
      }),
    } as unknown as TextGenerator;
    const consolidator = new MemoryConsolidator(store, jobStore(), generator);

    await expect(consolidator.run(NOW)).resolves.toMatchObject({ status: "completed" });
  });

  it("skips when the remaining triage budget cannot cover the call", async () => {
    const generator = { generate: vi.fn() } as unknown as TextGenerator;
    const consolidator = new MemoryConsolidator(
      memoryStore([note("preferences", BLOATED)]),
      jobStore({ monthlyUsage: 199_000 }),
      generator,
    );

    await expect(consolidator.run(NOW)).resolves.toEqual({ status: "no_budget" });
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it("waits for the triage job to be enabled with a watermark", async () => {
    const consolidator = new MemoryConsolidator(
      memoryStore([note("preferences", BLOATED)]),
      jobStore({ enabled: false }),
      { generate: vi.fn() } as unknown as TextGenerator,
    );
    await expect(consolidator.run(NOW)).resolves.toEqual({ status: "triage_not_ready" });
  });
});

it("threshold sits below the hard cap", () => {
  expect(CONSOLIDATION_THRESHOLD).toBeLessThan(4000);
});

function note(domain: string, content: string): MemoryNote {
  return { domain, content, updatedAt: "2026-07-01T00:00:00.000Z" };
}

function memoryStore(notes: MemoryNote[]): MemoryStore & { save: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockImplementation(async (domain: string) => notes.find((n) => n.domain === domain)),
    list: vi.fn().mockResolvedValue(notes),
    save: vi.fn().mockImplementation(async (domain: string, content: string) => ({
      domain,
      content,
      updatedAt: NOW.toISOString(),
    })),
  };
}

function jobStore(overrides: { enabled?: boolean; monthlyUsage?: number } = {}): JobStore & Record<string, ReturnType<typeof vi.fn>> {
  return {
    get: vi.fn().mockResolvedValue({
      id: "triage",
      enabled: overrides.enabled ?? true,
      model: "gpt-5-mini",
      monthlyTokenCap: 200_000,
      scheduleHourUtc: 0,
      credentialPreference: "byok",
      currentMonthUsage: overrides.monthlyUsage ?? 0,
      projectedMonthlyTokens: 0,
      lastRunAt: "2026-07-18T23:00:00.000Z",
    }),
    getMonthlyUsage: vi.fn().mockResolvedValue(overrides.monthlyUsage ?? 0),
    recordRun: vi.fn().mockResolvedValue(undefined),
    setEnabled: vi.fn().mockResolvedValue(undefined),
  } as JobStore & Record<string, ReturnType<typeof vi.fn>>;
}
