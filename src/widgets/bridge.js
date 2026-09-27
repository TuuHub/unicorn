// Minimal MCP Apps host bridge (ADR-0037) — only what the six unicorn widgets
// use: the initialize handshake, reading a tool result, the host's theme,
// calling a door tool, opening a link, handing a prompt to the model,
// telling the model what just happened, and reporting our own size.
//
// Spec verified against https://github.com/modelcontextprotocol/ext-apps
// (SEP-1865), specification/2026-01-26/apps.mdx, read 2026-09-26. Exact
// method names used below, all JSON-RPC 2.0 over postMessage:
//   ui/initialize                        (view -> host, request; result carries
//                                          hostCapabilities and hostContext)
//   ui/notifications/initialized         (view -> host, notification)
//   ui/notifications/tool-result         (host -> view, notification; carries
//                                          CallToolResult incl. structuredContent)
//   ui/notifications/host-context-changed (host -> view, notification; theme,
//                                          displayMode, safeAreaInsets, styles)
//   tools/call                           (view -> host, request)
//   ui/open-link                         (view -> host, request)
//   ui/message                           (view -> host, request; hands the host
//                                          a user-role message to hand to the
//                                          model — "Discuss this", etc.)
//   ui/update-model-context              (view -> host, request; advisory —
//                                          tells the model what a widget action
//                                          just did, without asking it to reply)
//   ui/notifications/size-changed        (view -> host, notification)
//
// ChatGPT's Apps SDK predates this extension and never speaks this postMessage
// protocol at all — it reads `structuredContent` off `window.openai.toolOutput`
// and injects `window.openai.callTool`/`window.openai.sendFollowUpMessage`
// directly as globals. src/widgets/index.ts declares both the MCP Apps
// `_meta.ui.resourceUri` and the legacy `openai/outputTemplate` alias so the
// same resource renders under either host; sendMessage() below prefers
// `window.openai.sendFollowUpMessage` when present and falls back to
// `ui/message` otherwise.
//
// Capability gating: the view checks `hostCapabilities.message` before sending
// ui/message and `hostCapabilities.updateModelContext` before sending
// ui/update-model-context (both returned in the ui/initialize result, spec
// "Capability Discovery"). ChatGPT's `window.openai.sendFollowUpMessage` also
// counts as message support. A host that declares neither gets hidden
// buttons, never dead ones — degrade per declared capability, never per brand.
//
// No host present (opened as a plain file, or under test): renders from
// window.__UNICORN_PREVIEW__ instead. That is the only fallback; there is no
// network call anywhere in this file.

export function detectCapabilities(hostCapabilities, openaiGlobal) {
  const caps = hostCapabilities || {};
  const hasFollowUp = !!(openaiGlobal && typeof openaiGlobal.sendFollowUpMessage === "function");
  return {
    message: hasFollowUp || !!caps.message,
    updateModelContext: !!caps.updateModelContext,
  };
}

// True only for a message whose `source` really is the frame we did our
// handshake with. `window.addEventListener("message", ...)` fires for a
// postMessage from *any* window that got a handle to this iframe — not just
// our host — and this bridge has no fixed host origin to check against (the
// resourceUri can be embedded by any MCP Apps host). Without this check, any
// other frame that obtains a reference to this widget's window could resolve
// a pending callTool()/request() promise itself (spoofing a tool result) or
// fire a fake ui/notifications/tool-result with attacker-chosen
// structuredContent. Checking event.source's identity — rather than trusting
// jsonrpc shape alone — is the check that still works without knowing the
// host's origin in advance.
export function isTrustedMessageSource(eventSource, parentWindow) {
  return eventSource === parentWindow;
}

const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto"]);

// Mirrors markdown.js's safeUrl allowlist. openLink's url can come from
// ingested item/course data (an Ed post, a Gmail message, a Canvas item) —
// none of it trustworthy — and it is handed either to window.open() directly
// (preview mode) or to the host via ui/open-link, neither of which is
// guaranteed to reject a "javascript:"/"data:" URL on its own.
export function isSafeLinkUrl(url) {
  const trimmed = String(url ?? "").trim();
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) return true; // relative or "#anchor" — never a script/data URL
  return SAFE_LINK_SCHEMES.has(schemeMatch[1].toLowerCase());
}

(function () {
  "use strict";

  const inIframe = typeof window !== "undefined" && window.parent && window.parent !== window;
  let requestId = 0;
  const pending = new Map();

  function post(message) {
    window.parent.postMessage(message, "*");
  }

  function request(method, params) {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method, params) {
    post({ jsonrpc: "2.0", method, params });
  }

  if (inIframe) {
    window.addEventListener("message", (event) => {
      if (!isTrustedMessageSource(event.source, window.parent)) return;
      const data = event.data;
      if (!data || data.jsonrpc !== "2.0") return;
      if (typeof data.id !== "undefined" && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message || "request failed"));
        else resolve(data.result);
        return;
      }
      if (data.method === "ui/notifications/tool-result") {
        bridge._onToolResult && bridge._onToolResult((data.params && data.params.structuredContent) ?? null);
      } else if (data.method === "ui/notifications/host-context-changed") {
        bridge._onHostContext && bridge._onHostContext(data.params || {});
      }
    });
  }

  const bridge = {
    _onToolResult: null,
    _onHostContext: null,
    // { message: boolean, updateModelContext: boolean } — set once by init(),
    // before the first onToolResult/onHostContext callback fires, so widget
    // code can read it synchronously wherever it decides what to render.
    capabilities: { message: false, updateModelContext: false },

    // Wires the two data callbacks and, in a real host, performs the
    // handshake; in preview/standalone mode it plays back the fixture once so
    // widget code never has to branch on "am I embedded".
    async init({ onToolResult, onHostContext } = {}) {
      bridge._onToolResult = onToolResult || null;
      bridge._onHostContext = onHostContext || null;
      const openaiGlobal = typeof window !== "undefined" ? window.openai : undefined;

      if (!inIframe) {
        const fixture = (typeof window !== "undefined" && window.__UNICORN_PREVIEW__) || {};
        bridge.capabilities = detectCapabilities(fixture.hostCapabilities, openaiGlobal);
        if (onHostContext) onHostContext(fixture.hostContext || {});
        if (onToolResult) onToolResult(fixture.structuredContent ?? null);
        return;
      }

      const result = await request("ui/initialize", {
        protocolVersion: "2026-01-26",
        appCapabilities: {},
        clientInfo: { name: "unicorn-widget", version: "0.1.0" },
      });
      bridge.capabilities = detectCapabilities(result && result.hostCapabilities, openaiGlobal);
      notify("ui/notifications/initialized", {});
      // The initial structuredContent is not in this response — it arrives via
      // its own ui/notifications/tool-result right after, handled by the
      // message listener above and delivered to onToolResult from there.
      if (onHostContext && result && result.hostContext) onHostContext(result.hostContext);
    },

    // Calls a door tool (e.g. ack_briefs, save_plan) and resolves with its
    // structuredContent, or throws with the tool's own error text.
    async callTool(name, args) {
      if (!inIframe) throw new Error("callTool is unavailable outside a host");
      const result = await request("tools/call", { name, arguments: args || {} });
      if (result && result.isError) {
        const text = (result.content || [])
          .map((block) => block.text)
          .filter(Boolean)
          .join(" ");
        throw new Error(text || `${name} failed`);
      }
      return (result && result.structuredContent) ?? null;
    },

    openLink(url) {
      if (!isSafeLinkUrl(url)) return Promise.reject(new Error("Unsafe link scheme"));
      if (!inIframe) {
        window.open(url, "_blank", "noopener,noreferrer");
        return Promise.resolve();
      }
      return request("ui/open-link", { url });
    },

    // Hands a precise, id-bearing prompt to the model as if the user typed
    // it — the "Discuss this" / "Break this down" family of buttons. Callers
    // must check bridge.capabilities.message before showing such a button;
    // this still throws if called anyway, rather than pretending to succeed.
    sendMessage(text) {
      const openaiGlobal = typeof window !== "undefined" ? window.openai : undefined;
      if (openaiGlobal && typeof openaiGlobal.sendFollowUpMessage === "function") {
        return Promise.resolve(openaiGlobal.sendFollowUpMessage({ prompt: text }));
      }
      if (!inIframe) return Promise.reject(new Error("sendMessage is unavailable outside a host"));
      return request("ui/message", { role: "user", content: { type: "text", text } });
    },

    // Tells the model what a widget action just did (a one-line factual
    // summary), without asking it to reply. Purely advisory: unsupported or
    // failed calls are swallowed rather than surfaced as a widget error, same
    // as the action they describe already succeeded on unicorn's own state.
    updateModelContext(summary) {
      if (!bridge.capabilities.updateModelContext || !inIframe) return Promise.resolve();
      return request("ui/update-model-context", { content: [{ type: "text", text: summary }] }).catch(() => {});
    },

    // Hosts size the iframe from this notification; without it a tall widget
    // gets clipped and scrolls inside its own inner scrollbar.
    watchSize() {
      if (!inIframe || typeof ResizeObserver === "undefined") return;
      let last = -1;
      const report = () => {
        const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
        if (height === last) return;
        last = height;
        notify("ui/notifications/size-changed", { width: document.documentElement.clientWidth, height });
      };
      new ResizeObserver(report).observe(document.documentElement);
      report();
    },
  };

  if (typeof window !== "undefined") {
    window.Unicorn = window.Unicorn || {};
    window.Unicorn.bridge = bridge;
  }
})();
