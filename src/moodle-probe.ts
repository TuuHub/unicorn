const DASHBOARD_PATH = "/my/";
const AJAX_PATH = "/lib/ajax/service.php";
const TIMELINE_METHOD = "core_calendar_get_action_events_by_timesort";

export interface MoodleProbeEnv {
  MOODLE_BASE_URL: string;
  MOODLE_SESSION: string;
}

export interface MoodleProbeResult {
  authenticated: true;
  checkedAt: string;
  timelineItemCount: number;
}

export class MoodleProbeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MoodleProbeError";
  }
}

export function parseSesskey(html: string): string {
  const patterns = [
    /"sesskey"\s*:\s*"([^"]+)"/,
    /\bsesskey\s*:\s*'([^']+)'/,
    /name=["']sesskey["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']sesskey["']/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      return match[1];
    }
  }

  throw new MoodleProbeError("sesskey_missing", "Authenticated dashboard did not contain a sesskey.");
}

export async function probeMoodle(
  env: MoodleProbeEnv,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<MoodleProbeResult> {
  const baseUrl = env.MOODLE_BASE_URL.replace(/\/$/, "");
  const session = env.MOODLE_SESSION.trim();
  if (!session) {
    throw new MoodleProbeError("session_missing", "MOODLE_SESSION is not configured.");
  }

  const headers = { cookie: `MoodleSession=${session}` };
  const dashboard = await fetcher(`${baseUrl}${DASHBOARD_PATH}`, {
    headers,
    redirect: "manual",
  });

  if (!dashboard.ok) {
    const code = dashboard.status >= 300 && dashboard.status < 400 ? "session_expired" : "dashboard_failed";
    throw new MoodleProbeError(code, `Moodle dashboard returned HTTP ${dashboard.status}.`);
  }

  const sesskey = parseSesskey(await dashboard.text());
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const response = await fetcher(
    `${baseUrl}${AJAX_PATH}?sesskey=${encodeURIComponent(sesskey)}&info=${TIMELINE_METHOD}`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify([
        {
          index: 0,
          methodname: TIMELINE_METHOD,
          args: {
            limitnum: 1,
            timesortfrom: nowSeconds,
            timesortto: 0,
            aftereventid: 0,
            limittononsuspendedevents: true,
          },
        },
      ]),
    },
  );

  if (!response.ok) {
    throw new MoodleProbeError("timeline_failed", `Moodle timeline returned HTTP ${response.status}.`);
  }

  const envelope: unknown = await response.json();
  if (!Array.isArray(envelope) || typeof envelope[0] !== "object" || envelope[0] === null) {
    throw new MoodleProbeError("timeline_invalid", "Moodle timeline returned an invalid response.");
  }

  const result = envelope[0] as { error?: boolean; data?: { events?: unknown[] }; exception?: { errorcode?: string } };
  if (result.error) {
    throw new MoodleProbeError(
      result.exception?.errorcode ?? "timeline_error",
      "Moodle timeline rejected the request.",
    );
  }

  return {
    authenticated: true,
    checkedAt: now.toISOString(),
    timelineItemCount: Array.isArray(result.data?.events) ? result.data.events.length : 0,
  };
}
