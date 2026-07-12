import { describe, expect, it, vi } from "vitest";
import { runRetention } from "../src/retention";

describe("runRetention", () => {
  it("archives items older than the configured hot window", async () => {
    const repository = { archiveBefore: vi.fn().mockResolvedValue(4) };

    const archived = await runRetention(repository, 30, new Date("2026-07-13T00:00:00.000Z"));

    expect(archived).toBe(4);
    expect(repository.archiveBefore).toHaveBeenCalledWith(
      "2026-06-13T00:00:00.000Z",
      "2026-07-13T00:00:00.000Z",
    );
  });
});
