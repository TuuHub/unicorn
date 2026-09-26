#!/usr/bin/env node
// SessionStart hook: pulls unread briefs from the unicorn door and surfaces
// their titles as additionalContext, so a session starts already knowing
// what changed. Must never add friction to `claude` startup: a short
// timeout, and silent (exit 0, no stdout) on any error or missing config —
// a slow or misconfigured Worker, or a plugin not configured yet, must look
// exactly like "nothing to report", never like a hang or a broken session.
//
// Talks to the door over MCP streamable HTTP with a single JSON-RPC
// `tools/call` for `get_briefs`. The door is stateless and answers with
// plain JSON, so no `initialize` handshake is needed — but a compliant MCP
// HTTP server may still frame the reply as one SSE event, so this handles
// both a plain JSON body and an SSE-framed one.
//
// Config comes from the plugin's userConfig (url, token), exported to this
// process as CLAUDE_PLUGIN_OPTION_URL / CLAUDE_PLUGIN_OPTION_TOKEN.

const TIMEOUT_MS = 3000;
const MAX_TITLES = 5;

async function main() {
  const url = process.env.CLAUDE_PLUGIN_OPTION_URL;
  const token = process.env.CLAUDE_PLUGIN_OPTION_TOKEN;
  if (!url || !token) return; // plugin not configured yet — stay silent

  const endpoint = `${url.replace(/\/+$/, "")}/mcp`;
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_briefs", arguments: { unreadOnly: true, limit: MAX_TITLES } },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: requestBody,
      signal: controller.signal,
    });
  } catch {
    return; // network error, timeout, DNS failure — stay silent
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return;

  let text;
  try {
    text = await response.text();
  } catch {
    return;
  }

  const rpc = parseRpcResponse(response.headers.get("content-type") ?? "", text);
  const briefs = rpc?.result?.structuredContent?.briefs;
  if (!Array.isArray(briefs) || briefs.length === 0) return;

  const titles = briefs.slice(0, MAX_TITLES).map((brief) => `- ${brief.title}`);
  const context = [
    `You have ${briefs.length} unread unicorn brief(s):`,
    ...titles,
    "Call get_briefs for details.",
  ].join("\n");

  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
}

// Parses either a plain JSON body or an SSE-framed one ("data: <json>" lines)
// into the JSON-RPC response object, or null if nothing usable was found.
function parseRpcResponse(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    for (const line of dataLines.reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        // a keepalive comment or partial frame isn't JSON — keep looking
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

main().catch(() => {
  // Never let an unhandled rejection surface as a Claude Code error.
});
