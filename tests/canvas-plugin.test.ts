import { describe, expect, it, vi } from "vitest";
import { CanvasPlugin } from "../src/plugins/campus/canvas-plugin";

describe("CanvasPlugin.pull", () => {
  it("maps courses (with and without term), paginated assignments across every submission state, staff announcements and discussion topics", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/courses?")) {
        return Response.json([
          {
            id: 100,
            name: "FIT2099 Object-Oriented Design and Implementation",
            course_code: "FIT2099",
            workflow_state: "available",
            start_at: "2026-07-13T00:00:00Z",
            term: { id: 5001, name: "Term 3 2026", start_at: "2026-07-13T00:00:00Z" },
          },
          {
            id: 200,
            name: "FIT2004 Algorithms and Data Structures",
            course_code: "FIT2004",
            workflow_state: "available",
            start_at: "2026-07-13T00:00:00Z",
          },
        ]);
      }
      if (url.includes("/courses/100/assignments?")) {
        if (url.includes("page=2")) {
          return Response.json([
            {
              id: 9002,
              name: "Assignment 2: Implementation",
              due_at: "2026-09-20T13:00:00Z",
              submission: { workflow_state: "submitted", missing: false, late: false, score: null },
            },
          ]);
        }
        return Response.json(
          [
            {
              id: 9001,
              name: "Assignment 1: Design Document",
              due_at: "2026-08-15T13:00:00Z",
              html_url: "https://learning.example.edu/courses/100/assignments/9001",
              submission: { workflow_state: "graded", missing: false, late: false, score: 87.5, grade: "87.5" },
            },
          ],
          {
            headers: {
              Link: '<https://learning.example.edu/api/v1/courses/100/assignments?page=2&per_page=100>; rel="next"',
            },
          },
        );
      }
      if (url.includes("/api/v1/announcements?") && url.includes("course_100")) {
        return Response.json([
          {
            id: 7001,
            title: "Assignment 1 extension",
            message: "<p>The deadline has been <strong>extended</strong> to Friday.</p>",
            posted_at: "2026-08-10T09:00:00Z",
            html_url: "https://learning.example.edu/courses/100/discussion_topics/7001",
            author: { id: 55, display_name: "Dr. Chen" },
          },
        ]);
      }
      if (url.includes("/courses/100/discussion_topics?")) {
        return Response.json([
          {
            id: 8001,
            title: "Week 5 general discussion",
            message: "<p>Post your questions about week 5 here.</p>",
            posted_at: "2026-08-05T09:00:00Z",
            html_url: "https://learning.example.edu/courses/100/discussion_topics/8001",
            is_announcement: false,
            author: { id: 300, display_name: "Some Student" },
          },
        ]);
      }
      if (url.includes("/courses/200/assignments?")) {
        return Response.json([
          {
            id: 9101,
            name: "Quiz 1",
            due_at: "2026-08-01T00:00:00Z",
            submission: { workflow_state: "unsubmitted", missing: false, late: false },
          },
          {
            id: 9102,
            name: "Quiz 2",
            due_at: "2026-07-01T00:00:00Z",
            submission: { workflow_state: "unsubmitted", missing: true, late: false },
          },
          {
            id: 9103,
            name: "Quiz 3",
            due_at: "2026-07-10T00:00:00Z",
            submission: { workflow_state: "submitted", missing: false, late: true },
          },
        ]);
      }
      if (url.includes("/api/v1/announcements?") && url.includes("course_200")) {
        return Response.json([]);
      }
      if (url.includes("/courses/200/discussion_topics?")) {
        return Response.json([
          {
            id: 8002,
            title: "Lab help thread",
            message: "<p>Ask lab questions here.</p>",
            posted_at: "2026-08-06T09:00:00Z",
            html_url: "https://learning.example.edu/courses/200/discussion_topics/8002",
            is_announcement: false,
            author: { id: 301 },
          },
        ]);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const plugin = new CanvasPlugin({
      baseUrl: "https://learning.example.edu",
      token: "canvas-secret",
      fetch: fetcher,
      now: () => new Date("2026-09-26T00:00:00Z"),
    });

    const items = await plugin.pull();
    const byId = new Map(items.map((item) => [item.id, item]));

    expect(items).toHaveLength(10);

    expect(byId.get("course:100")).toMatchObject({
      source: "campus-canvas",
      kind: "course",
      title: "FIT2099 Object-Oriented Design and Implementation",
      timestamp: "2026-07-13T00:00:00.000Z",
      facets: [
        expect.objectContaining({
          type: "course-identity",
          data: { platform: "canvas", platformId: "100", code: "FIT2099", term: "Term 3 2026", status: "available" },
        }),
      ],
    });
    expect(byId.get("course:200")).toMatchObject({
      facets: [expect.objectContaining({ type: "course-identity", data: expect.objectContaining({ term: null }) })],
    });

    // Assignment 9001 came from page 1, graded with a score.
    expect(byId.get("assignment:9001")).toMatchObject({
      source: "campus-canvas",
      kind: "assessment",
      title: "Assignment 1: Design Document",
      facets: expect.arrayContaining([
        expect.objectContaining({ type: "course-membership", data: { course: "course:100" } }),
        expect.objectContaining({
          type: "deadline",
          data: { dueAt: "2026-08-15T13:00:00.000Z" },
          capabilities: [{ name: "has-deadline", primitive: "temporal", field: "dueAt" }],
        }),
        expect.objectContaining({
          type: "submission",
          data: { status: "graded" },
          capabilities: [{ name: "has-submission-status", primitive: "state", field: "status" }],
        }),
        expect.objectContaining({
          type: "grade",
          data: { grade: 87.5 },
          capabilities: [{ name: "has-grade", primitive: "scalar", field: "grade" }],
        }),
      ]),
    });
    // Assignment 9002 came from page 2 (followed via the Link header), submitted with no score yet.
    expect(byId.get("assignment:9002")).toMatchObject({
      facets: expect.arrayContaining([
        expect.objectContaining({ type: "submission", data: { status: "submitted" } }),
      ]),
    });
    expect(byId.get("assignment:9002")?.facets.some((facet) => facet.type === "grade")).toBe(false);

    // The other three submission states.
    expect(byId.get("assignment:9101")).toMatchObject({
      facets: expect.arrayContaining([expect.objectContaining({ type: "submission", data: { status: "unsubmitted" } })]),
    });
    expect(byId.get("assignment:9102")).toMatchObject({
      facets: expect.arrayContaining([expect.objectContaining({ type: "submission", data: { status: "missing" } })]),
    });
    expect(byId.get("assignment:9103")).toMatchObject({
      facets: expect.arrayContaining([expect.objectContaining({ type: "submission", data: { status: "late" } })]),
    });

    // Announcements are staff posts by nature: authorRole is always "teacher".
    expect(byId.get("announcement:7001")).toMatchObject({
      kind: "announcement",
      title: "Assignment 1 extension",
      body: "The deadline has been extended to Friday.",
      facets: expect.arrayContaining([
        expect.objectContaining({
          type: "author",
          data: { actor: "canvas-user:55", authorRole: "teacher" },
        }),
        expect.objectContaining({ type: "course-membership", data: { course: "course:100" } }),
      ]),
    });

    // Discussion topics carry no reliable role field, so authorRole is left out.
    const discussion = byId.get("discussion:8001");
    expect(discussion).toMatchObject({ kind: "thread", body: "Post your questions about week 5 here." });
    const discussionAuthorFacet = discussion?.facets.find((facet) => facet.type === "author");
    expect(discussionAuthorFacet?.data).toEqual({ actor: "canvas-user:300" });

    expect(String(fetcher.mock.calls[0][0])).toContain("enrollment_type=student");
    expect(String(fetcher.mock.calls[0][0])).toContain("enrollment_state=active");
    expect(String(fetcher.mock.calls[0][0])).toContain("include%5B%5D=term");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer canvas-secret" });
    // The page-2 fetch actually happened (pagination followed the Link header).
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("page=2"))).toBe(true);
  });

  it("tolerates a 403 on one course's disabled tab without failing the whole pull", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/courses?")) {
        return Response.json([
          { id: 100, name: "Course A", course_code: "A", workflow_state: "available" },
          { id: 200, name: "Course B", course_code: "B", workflow_state: "available" },
        ]);
      }
      if (url.includes("/courses/100/assignments?")) return Response.json([]);
      if (url.includes("/api/v1/announcements?") && url.includes("course_100")) return Response.json([]);
      if (url.includes("/courses/100/discussion_topics?")) return Response.json([]);
      // Course B disabled its assignments tab for students.
      if (url.includes("/courses/200/assignments?")) return new Response("Forbidden", { status: 403 });
      if (url.includes("/api/v1/announcements?") && url.includes("course_200")) {
        return Response.json([
          { id: 7002, title: "Notice", message: "<p>Hi</p>", posted_at: "2026-08-01T00:00:00Z", author: { id: 9 } },
        ]);
      }
      if (url.includes("/courses/200/discussion_topics?")) {
        return Response.json([
          { id: 8003, title: "Thread", message: "<p>Hey</p>", posted_at: "2026-08-01T00:00:00Z", author: { id: 10 } },
        ]);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const plugin = new CanvasPlugin({ baseUrl: "https://learning.example.edu", token: "secret", fetch: fetcher });

    const items = await plugin.pull();

    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining(["course:100", "course:200", "announcement:7002", "discussion:8003"]),
    );
    expect(items.some((item) => item.id.startsWith("assignment:"))).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"canvas_tab_disabled"'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('"courseId":200'));

    consoleErrorSpy.mockRestore();
  });

  it("fails the whole pull on 401 and never puts the token in the error message", async () => {
    const token = "super-secret-canvas-token";
    const fetcher = vi.fn<typeof fetch>(async () => new Response("Unauthorized", { status: 401 }));
    const plugin = new CanvasPlugin({ baseUrl: "https://learning.example.edu", token, fetch: fetcher });

    let caught: Error | null = null;
    try {
      await plugin.pull();
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe("Canvas authentication failed.");
    expect(caught?.message).not.toContain(token);
  });

  it("stays within the documented subrequest budget for a 5-course student", async () => {
    const courseIds = [100, 200, 300, 400, 500];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/courses?")) {
        return Response.json(
          courseIds.map((id) => ({ id, name: `Course ${id}`, course_code: `C${id}`, workflow_state: "available" })),
        );
      }
      const courseMatch = /\/courses\/(\d+)\/assignments\?/.exec(url);
      if (courseMatch) {
        return Response.json([
          {
            id: Number(courseMatch[1]) * 10 + 1,
            name: "Assignment",
            due_at: "2026-08-01T00:00:00Z",
            submission: { workflow_state: "unsubmitted", missing: false, late: false },
          },
        ]);
      }
      if (url.includes("/api/v1/announcements?")) {
        return Response.json([]);
      }
      if (/\/courses\/(\d+)\/discussion_topics\?/.test(url)) {
        return Response.json([]);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const plugin = new CanvasPlugin({ baseUrl: "https://learning.example.edu", token: "secret", fetch: fetcher });

    await plugin.pull();

    // 1 courses call + 5 courses x 3 endpoints (assignments, announcements,
    // discussions), one page each here: 16 total. The plugin's documented
    // worst case (2 pages everywhere) for 6 courses is 38, and the Workers
    // free-tier ceiling is 50 subrequests/invocation.
    expect(fetcher.mock.calls).toHaveLength(16);
  });
});
