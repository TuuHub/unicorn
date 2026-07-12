import { MoodleProbeError, probeMoodle, type MoodleProbeEnv } from "./moodle-probe";

interface Env extends MoodleProbeEnv {
  PROBE_TOKEN: string;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ready" });
    }

    if (request.method === "POST" && url.pathname === "/probe") {
      if (request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`) {
        return json({ error: "unauthorized" }, 401);
      }

      try {
        return json(await probeMoodle(env));
      } catch (error) {
        const code = error instanceof MoodleProbeError ? error.code : "probe_failed";
        console.error(JSON.stringify({ event: "moodle_probe_failed", code }));
        return json({ error: code }, 502);
      }
    }

    return json({ error: "not_found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const result = await probeMoodle(env);
      console.log(JSON.stringify({ event: "moodle_probe_succeeded", ...result }));
    } catch (error) {
      const code = error instanceof MoodleProbeError ? error.code : "probe_failed";
      console.error(JSON.stringify({ event: "moodle_probe_failed", code }));
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
