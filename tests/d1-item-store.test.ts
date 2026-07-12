import { describe, expect, it, vi } from "vitest";
import { D1ItemStore } from "../src/kernel/d1-item-store";

describe("D1ItemStore.findMany", () => {
  it("loads any number of items with two database queries", async () => {
    const all = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT i.*")) {
        return {
          results: [
            {
              source: "campus-moodle",
              item_id: "assessment:1",
              kind: "assessment",
              title: "Assignment 1",
              timestamp: "2026-07-20T00:00:00.000Z",
              url: null,
              body: null,
              raw_json: "{}",
              created_at: "2026-07-13T00:00:00.000Z",
              updated_at: "2026-07-13T00:00:00.000Z",
              archived_at: null,
            },
          ],
        };
      }
      return {
        results: [
          {
            source: "campus-moodle",
            item_id: "assessment:1",
            type: "deadline",
            data_json: '{"dueAt":"2026-07-20T00:00:00.000Z"}',
            capabilities_json: '[{"name":"has-deadline","primitive":"temporal","field":"dueAt"}]',
          },
        ],
      };
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({ all: vi.fn(() => all(sql)) })),
    }));
    const store = new D1ItemStore({ prepare } as unknown as D1Database);

    const items = await store.findMany([{ source: "campus-moodle", itemId: "assessment:1" }]);

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(items).toEqual([
      expect.objectContaining({
        id: "assessment:1",
        title: "Assignment 1",
        facets: [expect.objectContaining({ type: "deadline" })],
      }),
    ]);
  });
});
