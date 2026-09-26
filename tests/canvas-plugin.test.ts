import { describe, expect, it, vi } from "vitest";
import { CanvasPlugin } from "../src/plugins/campus/canvas-plugin";

const BASE_URL = "https://learning.example.edu";

type Route = (courseId: number, url: string) => Response;

interface RouteOverrides {
  courses?: () => Response;
  assignments?: Route;
  announcements?: Route;
  discussions?: Route;
}

// Every focused test below only cares about one endpoint's response; everything
// else defaults to "one course, nothing else" so each test stays short and
// asserts a single behaviour, matching the surrounding tests' style.
function makeFetcher(courseIds: number[] = [100], overrides: RouteOverrides = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("/api/v1/courses?")) {
      return overrides.courses
        ? overrides.courses()
        : Response.json(
            courseIds.map((id) => ({ id, name: `Course ${id}`, course_code: `C${id}`, workflow_state: "available" })),
          );
    }
    // Assignments/discussions carry the course id in the path; announcements
    // carry it in `context_codes[]=course_<id>` instead.
    const courseId = Number(/\/courses\/(\d+)\//.exec(url)?.[1] ?? /course_(\d+)/.exec(url)?.[1] ?? 0);
    if (url.includes("/assignments?")) {
      return overrides.assignments ? overrides.assignments(courseId, url) : Response.json([]);
    }
    if (url.includes("/api/v1/announcements?")) {
      return overrides.announcements ? overrides.announcements(courseId, url) : Response.json([]);
    }
    if (url.includes("/discussion_topics?")) {
      return overrides.discussions ? overrides.discussions(courseId, url) : Response.json([]);
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

async function assignmentItems(fetcher: ReturnType<typeof makeFetcher>) {
  const plugin = new CanvasPlugin({ baseUrl: BASE_URL, token: "canvas-secret", fetch: fetcher });
  const items = await plugin.pull();
  return items.filter((item) => item.id.startsWith("assignment:"));
}

describe("CanvasPlugin.pull — courses", () => {
  it("sends the active-student filter, include[]=term and a bearer token", async () => {
    const fetcher = makeFetcher([100]);
    const plugin = new CanvasPlugin({ baseUrl: BASE_URL, token: "canvas-secret", fetch: fetcher });

    await plugin.pull();

    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("enrollment_type=student");
    expect(String(url)).toContain("enrollment_state=active");
    expect(String(url)).toContain("include%5B%5D=term");
    expect(init).toMatchObject({ redirect: "manual", headers: { Authorization: "Bearer canvas-secret" } });
  });

  it("maps course-identity with the term name when include[]=term returns one", async () => {
    const fetcher = makeFetcher([], {
      courses: () =>
        Response.json([
          { id: 100, name: "FIT2099", course_code: "FIT2099", workflow_state: "available", term: { name: "Term 3 2026" } },
        ]),
    });
    const plugin = new CanvasPlugin({ baseUrl: BASE_URL, token: "secret", fetch: fetcher });

    const items = await plugin.pull();

    const course = items.find((item) => item.id === "course:100");
    expect(course?.facets[0]).toMatchObject({ type: "course-identity", data: expect.objectContaining({ term: "Term 3 2026" }) });
  });

  it("maps course-identity with term null when the course has no term", async () => {
    const fetcher = makeFetcher([], {
      courses: () => Response.json([{ id: 100, name: "FIT2099", course_code: "FIT2099", workflow_state: "available" }]),
    });
    const plugin = new CanvasPlugin({ baseUrl: BASE_URL, token: "secret", fetch: fetcher });

    const items = await plugin.pull();

    const course = items.find((item) => item.id === "course:100");
    expect(course?.facets[0]).toMatchObject({ type: "course-identity", data: expect.objectContaining({ term: null }) });
  });
});

describe("CanvasPlugin.pull — pagination", () => {
  it("follows the Link header's rel=next across 2+ pages", async () => {
    const fetcher = makeFetcher([100], {
      assignments: (_courseId, url) => {
        if (url.includes("page=2")) {
          return Response.json([{ id: 2, name: "Page 2 assignment", submission: { workflow_state: "unsubmitted" } }]);
        }
        return Response.json([{ id: 1, name: "Page 1 assignment", submission: { workflow_state: "unsubmitted" } }], {
          headers: { Link: `<${BASE_URL}/api/v1/courses/100/assignments?page=2>; rel="next"` },
        });
      },
    });

    const items = await assignmentItems(fetcher);

    expect(items.map((item) => item.id)).toEqual(["assignment:1", "assignment:2"]);
  });

  it("stops at the page cap even if the server keeps returning rel=next", async () => {
    const fetcher = makeFetcher([100], {
      // Always hands back another "next" link, forever — a runaway/misbehaving
      // server. The plugin must not loop forever or blow the subrequest budget.
      assignments: (_courseId, url) => {
        const id = url.includes("page=") ? Number(/page=(\d+)/.exec(url)?.[1]) : 1;
        return Response.json([{ id, name: `Assignment ${id}`, submission: { workflow_state: "unsubmitted" } }], {
          headers: { Link: `<${BASE_URL}/api/v1/courses/100/assignments?page=${id + 1}>; rel="next"` },
        });
      },
    });

    const items = await assignmentItems(fetcher);

    const assignmentCalls = fetcher.mock.calls.filter((call) => String(call[0]).includes("/assignments?"));
    // PER_COURSE_PAGE_CAP is documented as 2 in canvas-plugin.ts.
    expect(assignmentCalls).toHaveLength(2);
    expect(items).toHaveLength(2);
  });

  it("never follows a cross-origin next link, so the token is never sent to another host", async () => {
    const fetcher = makeFetcher([100], {
      assignments: () =>
        Response.json([{ id: 1, name: "Assignment 1", submission: { workflow_state: "unsubmitted" } }], {
          headers: { Link: '<https://evil.example.com/api/v1/courses/100/assignments?page=2>; rel="next"' },
        }),
    });

    const items = await assignmentItems(fetcher);

    expect(items.map((item) => item.id)).toEqual(["assignment:1"]);
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("evil.example.com"))).toBe(false);
  });
});

describe("CanvasPlugin.pull — submission states", () => {
  function withSubmission(submission: Record<string, unknown>, dueAt = "2026-08-01T00:00:00Z") {
    return makeFetcher([100], {
      assignments: () =>
        Response.json([{ id: 1, name: "Assignment", due_at: dueAt, submission }]),
    });
  }

  it("maps a missing submission", async () => {
    const items = await assignmentItems(withSubmission({ workflow_state: "unsubmitted", missing: true, late: false }));
    const facet = items[0]?.facets.find((f) => f.type === "submission");
    expect(facet?.data).toEqual({ status: "missing" });
  });

  it("maps a graded submission with a grade facet built from the score", async () => {
    const items = await assignmentItems(
      withSubmission({ workflow_state: "graded", missing: false, late: false, score: 91.25 }),
    );
    const submissionFacet = items[0]?.facets.find((f) => f.type === "submission");
    const gradeFacet = items[0]?.facets.find((f) => f.type === "grade");
    expect(submissionFacet?.data).toEqual({ status: "graded" });
    expect(gradeFacet).toMatchObject({
      data: { grade: 91.25 },
      capabilities: [{ name: "has-grade", primitive: "scalar", field: "grade" }],
    });
  });

  it("maps a late submission", async () => {
    const items = await assignmentItems(withSubmission({ workflow_state: "submitted", missing: false, late: true }));
    const facet = items[0]?.facets.find((f) => f.type === "submission");
    expect(facet?.data).toEqual({ status: "late" });
  });

  it("maps a submitted submission", async () => {
    const items = await assignmentItems(withSubmission({ workflow_state: "submitted", missing: false, late: false }));
    const facet = items[0]?.facets.find((f) => f.type === "submission");
    expect(facet?.data).toEqual({ status: "submitted" });
  });

  it("maps an unsubmitted submission", async () => {
    const items = await assignmentItems(withSubmission({ workflow_state: "unsubmitted", missing: false, late: false }));
    const facet = items[0]?.facets.find((f) => f.type === "submission");
    expect(facet?.data).toEqual({ status: "unsubmitted" });
  });

  it("omits the deadline facet (and falls back to created_at) when due_at is absent", async () => {
    const fetcher = makeFetcher([100], {
      assignments: () =>
        Response.json([
          {
            id: 1,
            name: "No due date",
            created_at: "2026-07-01T00:00:00Z",
            submission: { workflow_state: "unsubmitted" },
          },
        ]),
    });

    const items = await assignmentItems(fetcher);

    expect(items[0]?.facets.some((f) => f.type === "deadline")).toBe(false);
    expect(items[0]?.timestamp).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("CanvasPlugin.pull — announcements", () => {
  it("sets the announcement author's role to teacher (announcements are staff posts by nature)", async () => {
    const fetcher = makeFetcher([100], {
      announcements: () =>
        Response.json([
          { id: 1, title: "Notice", message: "<p>Hi</p>", posted_at: "2026-08-01T00:00:00Z", author: { id: 55 } },
        ]),
    });
    const plugin = new CanvasPlugin({ baseUrl: BASE_URL, token: "secret", fetch: fetcher });

    const items = await plugin.pull();

    const authorFacet = items.find((item) => item.id === "announcement:1")?.facets.find((f) => f.type === "author");
    expect(authorFacet?.data).toEqual({ actor: "canvas-user:55", authorRole: "teacher" });
  });

  it("strips HTML from the announcement body: drops <script> content and decodes entities", async () => {
    const fetcher = makeFetcher([100], {
      announcements: () =>
        Response.json([
          {
            id: 1,
            title: "Notice",
            message:
              '<p>Read the &amp; syllabus &lt;here&gt;.</p><script>alert("hi")</script><p>Thanks!</p>',
            posted_at: "2026-08-01T00:00:00Z",
            author: { id: 55 },
          },
        ]),
    });
    const plugin = new CanvasPlugin({ baseUrl: BASE_URL, token: "secret", fetch: fetcher });

    const items = await plugin.pull();

    const announcement = items.find((item) => item.id === "announcement:1");
    expect(announcement?.body).toBe("Read the & syllabus <here>. Thanks!");
    expect(announcement?.body).not.toContain("alert");
    expect(announcement?.body).not.toContain("<script>");
  });
});

describe("CanvasPlugin.pull — discussion topics", () => {
  it("excludes topics flagged is_announcement from the discussion threads", async () => {
    const fetcher = makeFetcher([100], {
      discussions: () =>
        Response.json([
          { id: 1, title: "A real thread", message: "<p>hi</p>", posted_at: "2026-08-01T00:00:00Z", is_announcement: false, author: { id: 1 } },
          { id: 2, title: "Slipped-in announcement", message: "<p>hi</p>", posted_at: "2026-08-01T00:00:00Z", is_announcement: true, author: { id: 1 } },
        ]),
    });
    const plugin = new CanvasPlugin({ baseUrl: BASE_URL, token: "secret", fetch: fetcher });

    const items = await plugin.pull();

    expect(items.map((item) => item.id)).toContain("discussion:1");
    expect(items.map((item) => item.id)).not.toContain("discussion:2");
  });

  it("caps discussion topics to the configured discussionLimit", async () => {
    const fetcher = makeFetcher([100], {
      discussions: () =>
        Response.json([
          { id: 1, title: "Thread 1", posted_at: "2026-08-01T00:00:00Z", is_announcement: false, author: { id: 1 } },
          { id: 2, title: "Thread 2", posted_at: "2026-08-01T00:00:00Z", is_announcement: false, author: { id: 1 } },
          { id: 3, title: "Thread 3", posted_at: "2026-08-01T00:00:00Z", is_announcement: false, author: { id: 1 } },
        ]),
    });
    const plugin = new CanvasPlugin({ baseUrl: BASE_URL, token: "secret", fetch: fetcher, discussionLimit: 2 });

    const items = await plugin.pull();

    expect(items.filter((item) => item.id.startsWith("discussion:"))).toHaveLength(2);
  });
});

describe("CanvasPlugin.pull — failure handling", () => {
  it("tolerates a 403 on one course's disabled tab without failing the whole pull", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = makeFetcher([100, 200], {
      // Course 200 disabled its assignments tab for students.
      assignments: (courseId) =>
        courseId === 200
          ? new Response("Forbidden", { status: 403 })
          : Response.json([]),
      announcements: (courseId) =>
        courseId === 200
          ? Response.json([{ id: 7002, title: "Notice", message: "<p>Hi</p>", posted_at: "2026-08-01T00:00:00Z", author: { id: 9 } }])
          : Response.json([]),
      discussions: (courseId) =>
        courseId === 200
          ? Response.json([{ id: 8003, title: "Thread", message: "<p>Hey</p>", posted_at: "2026-08-01T00:00:00Z", author: { id: 10 } }])
          : Response.json([]),
    });
    const plugin = new CanvasPlugin({ baseUrl: BASE_URL, token: "secret", fetch: fetcher });

    const items = await plugin.pull();

    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining(["course:100", "course:200", "announcement:7002", "discussion:8003"]),
    );
    expect(items.some((item) => item.id.startsWith("assignment:"))).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"canvas_tab_disabled"'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('"courseId":200'));

    consoleErrorSpy.mockRestore();
  });

  it("fails the whole pull on 401 and never puts the token in the error message or in any console.error output", async () => {
    const token = "super-secret-canvas-token";
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async () => new Response("Unauthorized", { status: 401 }));
    const plugin = new CanvasPlugin({ baseUrl: BASE_URL, token, fetch: fetcher });

    let caught: Error | null = null;
    try {
      await plugin.pull();
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe("Canvas authentication failed.");
    expect(caught?.message).not.toContain(token);
    for (const call of consoleErrorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(token);
    }

    consoleErrorSpy.mockRestore();
  });

  it("stays within the documented subrequest budget for a 5-course student", async () => {
    const courseIds = [100, 200, 300, 400, 500];
    const fetcher = makeFetcher(courseIds, {
      assignments: (courseId) =>
        Response.json([{ id: courseId * 10 + 1, name: "Assignment", submission: { workflow_state: "unsubmitted" } }]),
    });
    const plugin = new CanvasPlugin({ baseUrl: BASE_URL, token: "secret", fetch: fetcher });

    await plugin.pull();

    // 1 courses call + 5 courses x 3 endpoints (assignments, announcements,
    // discussions), one page each here: 16 total. The plugin's documented
    // worst case (2 pages everywhere) for 6 courses is 38, and the Workers
    // free-tier ceiling is 50 subrequests/invocation.
    expect(fetcher.mock.calls).toHaveLength(16);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(38);
  });
});
