import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/index";

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
