import { describe, expect, it, vi } from "vitest";
import { MoodlePlugin } from "../src/plugins/campus/moodle-plugin";

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
                  action: { actionable: true },
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
      ]),
    });
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      "info=core_course_get_enrolled_courses_by_timeline_classification%2Ccore_calendar_get_action_events_by_timesort",
    );
    const requestBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as Array<{
      args: { limitnum?: number };
    }>;
    expect(requestBody[1]?.args.limitnum).toBe(50);
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
});
