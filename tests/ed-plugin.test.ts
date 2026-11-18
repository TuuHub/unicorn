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
              course: {
                id: 100,
                code: "FIT2099 S1 2026",
                name: "Object-Oriented Design",
                status: "active",
                session: "S1",
                year: "2026",
              },
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
              user: { id: 99, name: "Teaching Associate", course_role: "tutor" },
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
    expect(items[0]).toMatchObject({
      id: "course:100",
      source: "campus-ed",
      kind: "course",
      facets: [expect.objectContaining({ type: "course-identity", data: expect.objectContaining({ term: "S1 2026" }) })],
    });
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
          data: { actor: "ed-user:99", authorRole: "tutor" },
        }),
        expect.objectContaining({
          type: "engagement",
          data: { replies: 3, votes: 5, stars: 2 },
        }),
        expect.objectContaining({
          type: "discussion-category",
          data: { category: "Assignments" },
          capabilities: [],
        }),
      ]),
    });
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("courses/100/threads?limit=30");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer ed-secret" });
    expect(items[2]).not.toHaveProperty("body");
    // View counters tick on every read; keeping them in raw would rewrite the item every sync.
    const raw = (items[1] as unknown as { raw: { metrics: Record<string, unknown> } }).raw;
    expect(raw).not.toHaveProperty("updatedAt");
    expect(raw.metrics).toEqual(expect.objectContaining({ replyCount: 3 }));
    expect(raw.metrics).not.toHaveProperty("viewCount");
    const thread2Facets = (items[2] as { facets: Array<{ type: string; data: Record<string, unknown> }> }).facets;
    const authorFacet = thread2Facets.find((facet) => facet.type === "author");
    expect(authorFacet?.data).toEqual({ actor: "ed-user:100" });
    expect(thread2Facets.find((facet) => facet.type === "discussion-category")).toBeUndefined();
  });

  it("reads a thread with resolved authors, and turns Ed's errors into HTTP statuses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          thread: {
            id: 5001,
            number: 12,
            course_id: 100,
            user_id: 7,
            title: "Deadline?",
            document: "When is it due?",
            is_anonymous: false,
            vote_count: 2,
            created_at: "2026-07-12T10:00:00.000Z",
            answers: [{ id: 1, user_id: 99, document: "Friday.", is_endorsed: true, vote_count: 4, comments: [{ id: 2, user_id: 7, document: "Thanks" }] }],
            comments: [],
          },
          users: [
            { id: 7, name: "Student", course_role: "student" },
            { id: 99, name: "Tutor", course_role: "tutor" },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ message: "Not found" }, { status: 404 }));
    const plugin = new EdPlugin({ token: "t", fetch: fetcher });

    const view = await plugin.thread(5001);

    expect(view).toMatchObject({
      title: "Deadline?",
      url: "https://edstem.org/au/courses/100/discussion/12",
      post: { author: "Student", role: "student", votes: 2 },
      answers: [{ author: "Tutor", role: "tutor", endorsed: true, votes: 4, replies: [{ author: "Student", body: "Thanks" }] }],
    });
    await expect(plugin.thread(1)).rejects.toMatchObject({ name: "HttpStatusError", status: 404 });
  });

  it("defaults course and thread URLs to the au region, and honors an explicit region", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ user: { id: 1 }, courses: [{ course: { id: 100, code: "FIT2099", status: "active" } }] }),
      )
      .mockResolvedValueOnce(Response.json({ threads: [{ id: 1, number: 1, course_id: 100, title: "T" }] }));
    const defaultRegion = await new EdPlugin({ token: "t", fetch: fetcher }).pull();
    expect(defaultRegion[0]?.url).toBe("https://edstem.org/au/courses/100/discussion/");
    expect(defaultRegion[1]?.url).toBe("https://edstem.org/au/courses/100/discussion/1");

    const fetcherUs = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ user: { id: 1 }, courses: [{ course: { id: 100, code: "FIT2099", status: "active" } }] }),
      )
      .mockResolvedValueOnce(Response.json({ threads: [{ id: 1, number: 1, course_id: 100, title: "T" }] }));
    const usRegion = await new EdPlugin({ token: "t", region: "us", fetch: fetcherUs }).pull();
    expect(usRegion[0]?.url).toBe("https://edstem.org/us/courses/100/discussion/");
    expect(usRegion[1]?.url).toBe("https://edstem.org/us/courses/100/discussion/1");
  });
});
