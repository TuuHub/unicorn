import { describe, expect, it, vi } from "vitest";
import { parseTerm } from "../src/kernel/courses";
import { D1ItemStore } from "../src/kernel/d1-item-store";
import { Kernel } from "../src/kernel/kernel";
import { MoodlePlugin } from "../src/plugins/campus/moodle-plugin";
import { createTestDb } from "./support/sqlite-d1";

describe("MoodlePlugin.pull", () => {
  it("maps courses and timeline events into kernel items", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<script>M.cfg = {"sesskey":"fresh-key"};</script>'))
      .mockResolvedValueOnce(
        Response.json([
          {
            error: false,
            data: {
              courses: [
                {
                  id: 41031,
                  shortname: "FIT2099_S1_2026",
                  fullname: "FIT2099 Object-Oriented Design and Implementation",
                  startdate: 1_772_323_200,
                  visible: true,
                },
              ],
            },
          },
          {
            error: false,
            data: {
              events: [
                {
                  id: 99,
                  name: "Assignment 3",
                  timesort: 1_774_411_200,
                  url: "https://learning.example.edu/calendar/view.php?view=day",
                  overdue: false,
                  modulename: "assign",
                  purpose: "assessment",
                  submissionstatus: "submitted",
                  grade: 82.5,
                  action: { actionable: false },
                  course: { id: 41031, fullname: "FIT2099 Object-Oriented Design and Implementation" },
                },
              ],
            },
          },
        ]),
      );
    const plugin = new MoodlePlugin({
      baseUrl: "https://learning.example.edu",
      session: "session-secret",
      fetch: fetcher,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });

    const items = await plugin.pull();

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "course:41031",
      source: "campus-moodle",
      kind: "course",
      title: "FIT2099 Object-Oriented Design and Implementation",
      facets: [
        expect.objectContaining({
          type: "course-identity",
          data: expect.objectContaining({ code: "FIT2099_S1_2026", term: "S1 2026" }),
        }),
      ],
    });
    expect(items[1]).toMatchObject({
      id: "assessment:99",
      source: "campus-moodle",
      kind: "assessment",
      title: "Assignment 3",
      facets: expect.arrayContaining([
        expect.objectContaining({
          type: "deadline",
          data: { dueAt: "2026-03-25T04:00:00.000Z" },
          capabilities: [{ name: "has-deadline", primitive: "temporal", field: "dueAt" }],
        }),
        expect.objectContaining({
          type: "course-membership",
          data: { course: "course:41031" },
          capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }],
        }),
        expect.objectContaining({
          type: "submission",
          data: { status: "submitted" },
          capabilities: [{ name: "has-submission-status", primitive: "state", field: "status" }],
        }),
        expect.objectContaining({
          type: "grade",
          data: { grade: 82.5 },
          capabilities: [{ name: "has-grade", primitive: "scalar", field: "grade" }],
        }),
      ]),
    });
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      "info=core_course_get_enrolled_courses_by_timeline_classification%2Ccore_calendar_get_action_events_by_timesort",
    );
    const requestBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as Array<{
      args: { limitnum?: number };
    }>;
    expect(requestBody[1]?.args.limitnum).toBe(50);
    expect(plugin.complete()).toEqual(["course", "assessment"]);
  });

  it("reads this term's gradebooks and marks graded work as graded", async () => {
    const batch = (courses: unknown[], events: unknown[]) =>
      Response.json([
        { error: false, data: { courses } },
        { error: false, data: { events } },
      ]);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<script>M.cfg = {"sesskey":"k"};</script>'))
      .mockResolvedValueOnce(
        batch(
          [
            { id: 1, shortname: "FIT2094_S2_2026", fullname: "FIT2094 Databases", visible: true },
            { id: 2, shortname: "FIT1045_S1_2026", fullname: "FIT1045 Algorithms", visible: true },
            { id: 3, shortname: "MON-STUDENT-HUB", fullname: "Student hub", visible: true },
          ],
          [
            { id: 70, name: "Class Test 2", timesort: 1_790_000_000, url: "https://m.example.edu/mod/quiz/view.php?id=6031139", modulename: "quiz", purpose: "assessment", course: { id: 1 } },
            { id: 71, name: "Assignment 2", timesort: 1_790_000_000, url: "https://m.example.edu/mod/assign/view.php?id=6031152", modulename: "assign", purpose: "assessment", course: { id: 1 } },
          ],
        ),
      );
    const item = (cmid: number, name: string, grade: string, range: string) => ({ name, item_type: "mod", modname: "quiz", cmid, grade, range, percentage: "", weight: "", contribution: "", feedback: "", url: "", status: "" });
    const readGrades = vi.fn(async () => [
      {
        course_id: 1,
        course_name: "FIT2094",
        learner_name: "",
        total_grade: "",
        total_range: "",
        total_percentage: "",
        items: [item(6031139, "Class Test 2", "14.25", "0–15"), item(6031152, "Assignment 2", "-", "0–100"), { ...item(0, "Artefact total", "4.50", "0–35"), cmid: undefined }],
      },
    ]);
    const plugin = new MoodlePlugin({ baseUrl: "https://m.example.edu", session: "s", fetch: fetcher, readGrades, now: () => new Date("2026-09-01T00:00:00.000Z") });

    const items = await plugin.pull();

    // Only the latest term's units: not last semester's, not the hub.
    expect(readGrades).toHaveBeenCalledWith([1], { name: "MoodleSession", value: "s" }, "k");
    const byId = new Map(items.map((entry) => [entry.id, entry]));
    expect(byId.get("assessment:70")?.facets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "submission", data: { status: "graded" } }),
        expect.objectContaining({ type: "grade", data: { grade: "14.25", range: "0–15" } }),
      ]),
    );
    expect(byId.get("assessment:71")?.facets).toEqual(expect.arrayContaining([expect.objectContaining({ type: "submission", data: { status: "unknown" } })]));
    expect(byId.get("grade:6031139")).toMatchObject({ kind: "grade", title: "Class Test 2", url: "https://m.example.edu/mod/quiz/view.php?id=6031139" });
    expect(byId.get("grade:6031152")?.facets[1]?.data).toMatchObject({ grade: "", range: "0–100", order: 1 });
    expect([...byId.keys()].filter((id) => id.startsWith("grade:"))).toHaveLength(2);
    expect(plugin.complete()).toEqual(["course", "assessment", "grade"]);
    // The kernel validates the whole batch; one bad facet would fail the sync.
    await expect(new Kernel(new D1ItemStore(await createTestDb())).ingest(items)).resolves.toMatchObject({ created: items.length });
  });

  it("keeps last pull's grades when the gradebook can't be read", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<script>M.cfg = {"sesskey":"k"};</script>'))
      .mockResolvedValueOnce(Response.json([{ error: false, data: { courses: [{ id: 1, shortname: "FIT2094_S2_2026", visible: true }] } }, { error: false, data: { events: [] } }]));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const plugin = new MoodlePlugin({ baseUrl: "https://m.example.edu", session: "s", fetch: fetcher, readGrades: async () => { throw new Error("HTTP 500"); } });

    const items = await plugin.pull();

    expect(items.map((entry) => entry.kind)).toEqual(["course"]);
    expect(plugin.complete()).toEqual(["course", "assessment"]);
    errors.mockRestore();
  });

  it("reads the term from shortnames and full names in any common shape", () => {
    expect(parseTerm("FIT2099_S1_2026")).toBe("S1 2026");
    expect(parseTerm("FIT1043 - MUM S2 2025")).toBe("S2 2025");
    expect(parseTerm("ATS2946 - S2 2026")).toBe("S2 2026");
    expect(parseTerm("FIT1008-FIT2085_S1_2026")).toBe("S1 2026");
    expect(parseTerm("FIT2094 2026 S2")).toBe("S2 2026");
    expect(parseTerm("COMP1511 T3 2025")).toBe("T3 2025");
    expect(parseTerm("SEMESTER 2 2026")).toBe("S2 2026");
    expect(parseTerm("FIT2004")).toBeNull();
    expect(parseTerm("SOIT Student HUB UG")).toBeNull();
  });

  it("signs in again through renew when Moodle redirects to its login page", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 303, headers: { location: "https://learning.example.edu/login/index.php" } }))
      .mockResolvedValueOnce(new Response('<script>M.cfg = {"sesskey":"k"};</script>'))
      .mockResolvedValueOnce(Response.json([{ error: false, data: { courses: [] } }, { error: false, data: { events: [] } }]));
    const renew = vi.fn(async () => ({ name: "MoodleSessionlearning", value: "renewed" }));
    const plugin = new MoodlePlugin({ baseUrl: "https://learning.example.edu", session: "old", fetch: fetcher, renew });

    await plugin.pull();

    expect(renew).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("cookie")).toBe("MoodleSessionlearning=renewed");
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get("cookie")).toBe("MoodleSessionlearning=renewed");
  });

  it("keeps the redirect error when nothing can renew the session", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 303 }));
    const plugin = new MoodlePlugin({ baseUrl: "https://learning.example.edu", session: "old", fetch: fetcher, renew: async () => null });

    await expect(plugin.pull()).rejects.toMatchObject({ status: 303 });
  });

  it("omits term when the shortname carries no session+year suffix", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<script>M.cfg = {"sesskey":"fresh-key"};</script>'))
      .mockResolvedValueOnce(
        Response.json([
          {
            error: false,
            data: { courses: [{ id: 1, shortname: "SANDBOX", fullname: "Sandbox", startdate: 0, visible: true }] },
          },
          { error: false, data: { events: [] } },
        ]),
      );
    const plugin = new MoodlePlugin({ baseUrl: "https://learning.example.edu", session: "session-secret", fetch: fetcher });

    const items = await plugin.pull();

    const identity = (items[0] as { facets: Array<{ type: string; data: Record<string, unknown> }> }).facets.find(
      (facet) => facet.type === "course-identity",
    );
    expect(identity?.data).not.toHaveProperty("term");
  });

  it("invokes an injected fetch function without using the plugin as its receiver", async () => {
    const responses = [
      new Response('<script>M.cfg = {"sesskey":"fresh-key"};</script>'),
      Response.json([
        { error: false, data: { courses: [] } },
        { error: false, data: { events: [] } },
      ]),
    ];
    const strictFetch = function (this: unknown): Promise<Response> {
      if (this !== undefined) {
        throw new TypeError("Illegal fetch receiver");
      }
      return Promise.resolve(responses.shift()!);
    } as typeof fetch;
    const plugin = new MoodlePlugin({
      baseUrl: "https://learning.example.edu",
      session: "session-secret",
      fetch: strictFetch,
    });

    await expect(plugin.pull()).resolves.toEqual([]);
  });

  it("does not mislabel non-assessment timeline actions or ambiguous submission state", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<script>M.cfg = {"sesskey":"fresh-key"};</script>'))
      .mockResolvedValueOnce(
        Response.json([
          { error: false, data: { courses: [] } },
          {
            error: false,
            data: {
              events: [
                {
                  id: 1,
                  name: "Read week 1 resources",
                  timesort: 1_774_411_200,
                  modulename: "label",
                  purpose: "content",
                  action: { name: "View", actionable: true },
                  course: { id: 10 },
                },
                {
                  id: 2,
                  name: "Assignment 1",
                  timesort: 1_774_411_200,
                  modulename: "assign",
                  purpose: "assessment",
                  action: { name: "Add submission", actionable: false },
                  course: { id: 10 },
                },
                {
                  id: 3,
                  name: "Assignment 2",
                  timesort: 1_774_411_200,
                  modulename: "assign",
                  purpose: "assessment",
                  overdue: true,
                  action: { name: "Add submission", actionable: true },
                  course: { id: 10 },
                },
              ],
            },
          },
        ]),
      );
    const plugin = new MoodlePlugin({
      baseUrl: "https://learning.example.edu",
      session: "session-secret",
      fetch: fetcher,
    });

    const items = await plugin.pull();

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "assessment:2",
      facets: expect.arrayContaining([
        expect.objectContaining({ type: "submission", data: { status: "unknown" } }),
      ]),
    });
    expect(items[1]).toMatchObject({
      id: "assessment:3",
      facets: expect.arrayContaining([
        expect.objectContaining({ type: "submission", data: { status: "unknown" } }),
      ]),
    });
  });
});
