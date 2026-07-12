import { describe, expect, it, vi } from "vitest";
import { MoodleProbeError, parseSesskey, probeMoodle } from "../src/moodle-probe";

const env = {
  MOODLE_BASE_URL: "https://learning.example.edu",
  MOODLE_SESSION: "session-secret",
};

describe("parseSesskey", () => {
  it("extracts the Moodle page context sesskey", () => {
    expect(parseSesskey('<script>M.cfg = {"sesskey":"fresh-key"};</script>')).toBe("fresh-key");
  });

  it("fails when the dashboard is not authenticated", () => {
    expect(() => parseSesskey("<html>Login</html>")).toThrowError(MoodleProbeError);
  });
});

describe("probeMoodle", () => {
  it("loads the dashboard and calls the timeline AJAX method", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<script>M.cfg = {"sesskey":"fresh-key"};</script>'))
      .mockResolvedValueOnce(Response.json([{ error: false, data: { events: [{ id: 1 }] } }]));

    const result = await probeMoodle(env, fetcher, new Date("2026-07-13T00:00:00.000Z"));

    expect(result).toEqual({
      authenticated: true,
      checkedAt: "2026-07-13T00:00:00.000Z",
      timelineItemCount: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://learning.example.edu/my/");
    expect(fetcher.mock.calls[1]?.[0]).toContain("info=core_calendar_get_action_events_by_timesort");
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({
      cookie: "MoodleSession=session-secret",
      "content-type": "application/json",
    });
  });

  it("reports an expired session without following the login redirect", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://login.example.edu" },
      }),
    );

    await expect(probeMoodle(env, fetcher)).rejects.toMatchObject({ code: "session_expired" });
  });
});
