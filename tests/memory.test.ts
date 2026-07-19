import { describe, expect, it, vi } from "vitest";
import { D1MemoryStore, estimateTokens, MemoryCapExceededError, MEMORY_TOKEN_CAP } from "../src/memory";

describe("D1MemoryStore", () => {
  it("returns an empty note for an unknown domain", async () => {
    const db = fakeDb(null);
    const store = new D1MemoryStore(db);
    await expect(store.get("preferences")).resolves.toMatchObject({ domain: "preferences", content: "" });
  });

  it("rejects a note over the token cap so full-read stays viable", async () => {
    const store = new D1MemoryStore(fakeDb(null));
    const oversized = "x".repeat((MEMORY_TOKEN_CAP + 10) * 4);
    await expect(store.save("preferences", oversized)).rejects.toBeInstanceOf(MemoryCapExceededError);
  });

  it("rejects a domain that is not a kebab-case slug", async () => {
    const store = new D1MemoryStore(fakeDb(null));
    await expect(store.save("Not A Slug", "content")).rejects.toThrow(/kebab-case/);
  });

  it("persists a valid note", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const db = fakeDb(null, run);
    const store = new D1MemoryStore(db, () => new Date("2026-07-19T00:00:00.000Z"));
    const note = await store.save("per-course", "FIT2099 quizzes don't count.");
    expect(note).toEqual({ domain: "per-course", content: "FIT2099 quizzes don't count.", updatedAt: "2026-07-19T00:00:00.000Z" });
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("estimateTokens", () => {
  it("approximates four characters per token for Latin text", () => {
    expect(estimateTokens("12345678")).toBe(2);
  });

  it("counts CJK characters far more heavily than length/4 so the cap holds", () => {
    // 8 Han characters would be 2 tokens under a naive length/4; real tokenizers put
    // this near one-token-per-character, so the estimate must be much higher.
    expect(estimateTokens("课程作业截止日期")).toBeGreaterThanOrEqual(5);
  });
});

function fakeDb(row: unknown, run = vi.fn().mockResolvedValue({ meta: { changes: 1 } })) {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        first: vi.fn().mockResolvedValue(row),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run,
      };
    },
  } as unknown as D1Database;
}
