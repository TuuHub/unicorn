import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Exercises claude-plugin/hooks/pull-briefs.mjs the way Claude Code actually
// runs a SessionStart hook: as a child process reading CLAUDE_PLUGIN_OPTION_*
// env vars and writing JSON to stdout. A fake node:http server stands in for
// the door, so these cover the wire format (JSON-RPC, plain JSON vs
// SSE-framed) and every "stay silent" path without touching a real Worker.

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve(__dirname, "../claude-plugin/hooks/pull-briefs.mjs");

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withServer(handler: Handler, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function runHook(env: Record<string, string>) {
  return execFileAsync("node", [SCRIPT], { env: { ...process.env, ...env }, timeout: 6000 });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

describe("pull-briefs SessionStart hook", () => {
  it("prints unread brief titles as additionalContext", async () => {
    await withServer(
      (req, res) => {
        readBody(req).then((body) => {
          const rpc = JSON.parse(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                structuredContent: {
                  briefs: [
                    { id: "1", kind: "digest", subject: "s", title: "Deadline moved for FIT3175", body: "", createdAt: "t", readAt: null },
                    { id: "2", kind: "forum-brief", subject: "s", title: "New staff post in FIT2004", body: "", createdAt: "t", readAt: null },
                  ],
                  unread: 2,
                },
              },
            }),
          );
        });
      },
      async (url) => {
        const { stdout } = await runHook({ CLAUDE_PLUGIN_OPTION_URL: url, CLAUDE_PLUGIN_OPTION_TOKEN: "test-token" });
        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
        expect(parsed.hookSpecificOutput.additionalContext).toContain("Deadline moved for FIT3175");
        expect(parsed.hookSpecificOutput.additionalContext).toContain("New staff post in FIT2004");
        expect(parsed.hookSpecificOutput.additionalContext).toContain("Call get_briefs for details.");
      },
    );
  });

  it("calls tools/call get_briefs with the bearer token and MCP accept header", async () => {
    let seenAuth = "";
    let seenAccept = "";
    let seenBody: any;
    await withServer(
      (req, res) => {
        seenAuth = req.headers.authorization ?? "";
        seenAccept = req.headers.accept ?? "";
        readBody(req).then((body) => {
          seenBody = JSON.parse(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: seenBody.id, result: { structuredContent: { briefs: [], unread: 0 } } }),
          );
        });
      },
      async (url) => {
        await runHook({ CLAUDE_PLUGIN_OPTION_URL: url, CLAUDE_PLUGIN_OPTION_TOKEN: "secret-token" });
        expect(seenAuth).toBe("Bearer secret-token");
        expect(seenAccept).toContain("application/json");
        expect(seenAccept).toContain("text/event-stream");
        expect(seenBody).toMatchObject({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "get_briefs", arguments: { unreadOnly: true, limit: 5 } },
        });
      },
    );
  });

  it("strips a trailing slash from the configured URL before appending /mcp", async () => {
    let seenPath = "";
    await withServer(
      (req, res) => {
        seenPath = req.url ?? "";
        readBody(req).then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { briefs: [], unread: 0 } } }));
        });
      },
      async (url) => {
        await runHook({ CLAUDE_PLUGIN_OPTION_URL: `${url}/`, CLAUDE_PLUGIN_OPTION_TOKEN: "t" });
        expect(seenPath).toBe("/mcp");
      },
    );
  });

  it("prints nothing when there are no unread briefs", async () => {
    await withServer(
      (req, res) => {
        readBody(req).then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { briefs: [], unread: 0 } } }));
        });
      },
      async (url) => {
        const { stdout } = await runHook({ CLAUDE_PLUGIN_OPTION_URL: url, CLAUDE_PLUGIN_OPTION_TOKEN: "t" });
        expect(stdout.trim()).toBe("");
      },
    );
  });

  it("parses an SSE-framed reply", async () => {
    await withServer(
      (req, res) => {
        readBody(req).then((body) => {
          const rpc = JSON.parse(body);
          const payload = JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { structuredContent: { briefs: [{ id: "1", title: "SSE brief", readAt: null }], unread: 1 } },
          });
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`event: message\ndata: ${payload}\n\n`);
        });
      },
      async (url) => {
        const { stdout } = await runHook({ CLAUDE_PLUGIN_OPTION_URL: url, CLAUDE_PLUGIN_OPTION_TOKEN: "t" });
        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput.additionalContext).toContain("SSE brief");
      },
    );
  });

  it("stays silent, and never calls the door, when the token is not configured", async () => {
    let called = false;
    await withServer(
      (_req, res) => {
        called = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      },
      async (url) => {
        const { stdout } = await runHook({ CLAUDE_PLUGIN_OPTION_URL: url });
        expect(stdout.trim()).toBe("");
        expect(called).toBe(false);
      },
    );
  });

  it("stays silent on a non-200 response", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(500);
        res.end("boom");
      },
      async (url) => {
        const { stdout } = await runHook({ CLAUDE_PLUGIN_OPTION_URL: url, CLAUDE_PLUGIN_OPTION_TOKEN: "t" });
        expect(stdout.trim()).toBe("");
      },
    );
  });

  it("stays silent on a malformed JSON body", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not json");
      },
      async (url) => {
        const { stdout } = await runHook({ CLAUDE_PLUGIN_OPTION_URL: url, CLAUDE_PLUGIN_OPTION_TOKEN: "t" });
        expect(stdout.trim()).toBe("");
      },
    );
  });

  it(
    "times out and stays silent when the door never responds",
    async () => {
      await withServer(
        () => {
          // Never call res.end() — simulates a hung or unreachable Worker.
        },
        async (url) => {
          const start = Date.now();
          const { stdout } = await runHook({ CLAUDE_PLUGIN_OPTION_URL: url, CLAUDE_PLUGIN_OPTION_TOKEN: "t" });
          const elapsed = Date.now() - start;
          expect(stdout.trim()).toBe("");
          // Proves the script's own ~3s abort fired rather than running to the
          // child-process timeout (6s) or hanging the test.
          expect(elapsed).toBeLessThan(5000);
        },
      );
    },
    8000,
  );
});
