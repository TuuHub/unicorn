import { describe, expect, it, vi } from "vitest";
import { EdPlugin } from "../src/plugins/campus/ed-plugin";

describe("EdPlugin.pull", () => {
  it("maps active courses and recent threads into kernel items", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          user: { id: 7, name: "Student" },
          courses: [
            {
              course: { id: 100, code: "FIT2099 S1 2026", name: "Object-Oriented Design", status: "active" },
              role: { role: "student" },
            },
            {
              course: { id: 200, code: "OLD1000", name: "Archived", status: "archived" },
              role: { role: "student" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          threads: [
            {
              id: 5001,
              number: 12,
              course_id: 100,
              user_id: 99,
              title: "Assignment deadline clarification",
              document: "The deadline shown in Moodle is correct.",
              type: "question",
              category: "Assignments",
              is_answered: true,
              is_locked: false,
              is_pinned: true,
              reply_count: 3,
              vote_count: 5,
              view_count: 150,
              star_count: 2,
              created_at: "2026-07-12T10:00:00.000Z",
              updated_at: "2026-07-12T12:00:00.000Z",
            },
            {
              id: 5002,
              number: 13,
              course_id: 100,
              user_id: 100,
              title: "Thread without a document body",
              type: "post",
              created_at: "2026-07-12T11:00:00.000Z",
            },
          ],
        }),
      );
    const plugin = new EdPlugin({
      token: "ed-secret",
      fetch: fetcher,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });

    const items = await plugin.pull();

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ id: "course:100", source: "campus-ed", kind: "course" });
    expect(items[1]).toMatchObject({
      id: "thread:5001",
      source: "campus-ed",
      kind: "thread",
      body: "The deadline shown in Moodle is correct.",
      facets: expect.arrayContaining([
        expect.objectContaining({
          type: "course-membership",
          data: { course: "course:100" },
        }),
        expect.objectContaining({
          type: "author",
          data: { actor: "ed-user:99" },
        }),
        expect.objectContaining({
          type: "engagement",
          data: { replies: 3, votes: 5, views: 150, stars: 2 },
        }),
      ]),
    });
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("courses/100/threads?limit=30");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer ed-secret" });
    expect(items[2]).not.toHaveProperty("body");
  });
});
