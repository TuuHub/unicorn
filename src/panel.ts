// The panel (ADR-0048): the human side of unicorn. Four pages next to /settings:
//
//   /panel           overview — this term, what's due, what your agents did, setup checklist
//   /panel/activity  the transparent log: every tool call (which client, which arguments,
//                    how long, did it fail) and every source sync
//   /panel/memory    read and edit what your agents remember about you (ADR-0047)
//   /panel/connect   connect Claude, ChatGPT, Claude Code or any MCP client; revoke apps
//
// Rendered on the server like /settings (ADR-0026: plain HTML strings, inline progressive
// enhancement only). Both deployments mount it: a self-deployed Worker behind the /settings
// Basic auth, the hosted server behind a signed-in session (ADR-0046). It never shows a
// credential except the door bearer token on Connect, which belongs to the viewer.

import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import type { ActivityEntry, ActivityKind, ActivityLog } from "./activity";
import { MEMORY_TARGETS, MemoryOperationError, type MemoryTarget, type MemoryView, readAllMemory, replaceMemory } from "./agent-memory";
import type { BriefStore } from "./briefs";
import type { MemoryStore } from "./memory";
import { MemoryConflictError } from "./memory";
import type { ItemSummary } from "./mcp/door-contracts";
import type { DoorRepository } from "./mcp/door-repository";
import { computeCsrfToken, type LastCycleInfo } from "./settings";
import { loadTermCourses, type TermCourse } from "./term";
import { escapeHtml, htmlResponse, renderPage } from "./ui";

export interface PanelRuntime {
  db: D1Database;
  adminToken: string; // CSRF key, as on /settings
  memory: MemoryStore;
  activity: ActivityLog;
  briefs: BriefStore;
  repo: DoorRepository;
  timezone: string;
  lastCycle: LastCycleInfo;
  itemCounts: Record<string, number>;
  configuredSources: number;
  schedulerRunning: boolean;
  doorUrl: string;
  bearerToken: string | null;
  bearerLabel: string; // "MCP_TOKEN" on a Worker, "personal access token" when hosted
  grants: GrantSummary[];
  hosted: boolean;
  now?: () => Date;
}

const SOURCE_NAMES: Record<string, string> = {
  "campus-moodle": "Moodle",
  "campus-ed": "Ed",
  "campus-canvas": "Canvas",
  gmail: "Gmail",
};

export async function handlePanel(request: Request, runtime: PanelRuntime): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/panel";

  if (request.method === "POST") {
    if (request.headers.get("origin") !== url.origin) {
      return new Response("Invalid request origin.", { status: 403 });
    }
    const form = await request.formData();
    if (String(form.get("csrf") ?? "") !== (await computeCsrfToken(runtime.adminToken))) {
      return new Response("Invalid form token. Reload the page and try again.", { status: 403 });
    }
    const memoryMatch = path.match(/^\/panel\/memory\/(user|notes|corrections)$/);
    if (memoryMatch) {
      return saveMemory(runtime, memoryMatch[1] as MemoryTarget, form, url);
    }
    return new Response("Not found.", { status: 404 });
  }

  if (request.method !== "GET") {
    return new Response("Method not allowed.", { status: 405, headers: { allow: "GET, POST" } });
  }
  switch (path) {
    case "/panel":
      return htmlResponse(await renderOverview(runtime));
    case "/panel/activity":
      return htmlResponse(await renderActivity(runtime, url));
    case "/panel/memory":
      return htmlResponse(await renderMemoryPage(runtime, url));
    case "/panel/connect":
      return htmlResponse(await renderConnect(runtime, url));
    default:
      return new Response("Not found.", { status: 404 });
  }
}

// --- overview -----------------------------------------------------------------

async function renderOverview(runtime: PanelRuntime): Promise<string> {
  const now = runtime.now ? runtime.now() : new Date();
  const [courses, upcoming, unread, stats, recent, memory] = await Promise.all([
    loadTermCourses(runtime.db).catch((): TermCourse[] => []),
    runtime.repo.upcoming({ days: 7, includeOverdue: false, now }).catch((): ItemSummary[] => []),
    runtime.briefs.list({ unreadOnly: true, limit: 1000 }).catch(() => []),
    runtime.activity.stats(now),
    runtime.activity.list({ limit: 8 }),
    readAllMemory(runtime.memory),
  ]);
  const totalItems = Object.values(runtime.itemCounts).reduce((sum, count) => sum + count, 0);
  const user = memory.find((view) => view.target === "user")!;

  const checklist = [
    { done: runtime.configuredSources > 0, text: `Add a source — Ed, Moodle, Canvas or Gmail. <a href="/settings">Sources →</a>` },
    { done: totalItems > 0, text: `First sync — unicorn pulls every hour; <a href="/settings">Sync now</a> to start immediately.` },
    { done: runtime.grants.length > 0 || stats.toolCalls24h > 0 || stats.clients7d.length > 0, text: `Connect your AI — Claude, ChatGPT or Claude Code. <a href="/panel/connect">Connect →</a>` },
    { done: user.entries.length > 0, text: `Say hi — ask your agent <em>“get to know me”</em>. It runs the onboard playbook and fills your profile.` },
  ];
  const setupDone = checklist.every((step) => step.done);

  const tiles = [
    tile("Units this term", String(courses.length), courses[0]?.term ?? (courses.length ? "" : "after the first sync")),
    tile("Due in 7 days", String(upcoming.length), upcoming[0]?.dueAt ? `next ${relative(upcoming[0].dueAt, now)}` : "nothing due"),
    tile("Unread briefs", String(unread.length), "your agent reads these first"),
    tile("Agent calls · 24h", String(stats.toolCalls24h), stats.errors24h ? `${stats.errors24h} error${stats.errors24h === 1 ? "" : "s"}` : "no errors"),
    tile("Last sync", runtime.lastCycle.at ? relative(runtime.lastCycle.at, now) : "never", runtime.schedulerRunning ? "hourly · running" : "scheduler stopped"),
  ].join("");

  const termList = courses.length
    ? `<ul class="list">${courses
        .map((course) => `<li><span><strong>${escapeHtml(course.code)}</strong> <span class="muted">${escapeHtml(course.title ?? "")}</span></span><span class="muted">${escapeHtml(course.sources.join(" · "))}</span></li>`)
        .join("")}</ul>`
    : `<p class="muted">No units yet. They appear here after the first sync, and your agent gets them in memory automatically.</p>`;

  const dueList = upcoming.length
    ? `<ul class="list">${upcoming
        .slice(0, 8)
        .map(
          (item) =>
            `<li><span>${item.course ? `<span class="badge">${escapeHtml(item.course)}</span> ` : ""}${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</span><span class="muted">${item.dueAt ? timeTag(item.dueAt) : ""}</span></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">Nothing due in the next 7 days.</p>`;

  const clients = stats.clients7d.length
    ? `<ul class="list">${stats.clients7d.map((client) => `<li><span>${escapeHtml(client.actor)}</span><span class="muted">${client.calls} calls · ${relative(client.lastAt, now)}</span></li>`).join("")}</ul>`
    : `<p class="muted">No agent has called unicorn in the last 7 days.</p>`;

  const body = `
    ${setupDone ? "" : `<section class="card"><div class="card-head"><h2>Get started</h2><p class="card-sub">Four steps, a few minutes.</p></div><div class="card-body"><ol class="steps">${checklist.map((step) => `<li class="${step.done ? "done" : ""}">${step.text}</li>`).join("")}</ol></div></section>`}
    <div class="tiles">${tiles}</div>
    <div class="grid2">
      <section class="card"><div class="card-head"><h2>This term</h2><p class="card-sub">Detected from your sources — kept in your agent's TERM memory.</p></div><div class="card-body">${termList}</div></section>
      <section class="card"><div class="card-head"><h2>Due this week</h2><p class="card-sub">Across every unit and system.</p></div><div class="card-body">${dueList}</div></section>
      <section class="card"><div class="card-head"><h2>Your agents</h2><p class="card-sub">Clients that called unicorn in the last 7 days.</p></div><div class="card-body">${clients}</div></section>
      <section class="card"><div class="card-head"><h2>What your agent knows about you</h2><p class="card-sub">${user.entries.length} profile entr${user.entries.length === 1 ? "y" : "ies"} · <a href="/panel/memory">edit memory →</a></p></div><div class="card-body">${
        user.entries.length
          ? `<ul class="list">${user.entries.slice(0, 6).map((entry) => `<li><span>${escapeHtml(entry)}</span></li>`).join("")}</ul>`
          : `<p class="muted">Nothing yet. Ask your agent “get to know me”.</p>`
      }</div></section>
    </div>
    <section class="card" style="margin-top:16px"><div class="card-head"><h2>Recent activity</h2><p class="card-sub"><a href="/panel/activity">Full log →</a></p></div><div class="card-body">${renderActivityTable(recent, now, false)}</div></section>
    ${PANEL_SCRIPT}`;

  return renderPage({
    title: "unicorn",
    active: "/panel",
    heading: "Overview",
    subtitle: runtime.hosted ? "Your campus memory, hosted. Everything your agents read and wrote is listed under Activity." : "Your campus memory. Everything your agents read and wrote is listed under Activity.",
    body,
    wide: true,
  });
}

function tile(label: string, value: string, hint: string): string {
  return `<div class="tile"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="hint">${escapeHtml(hint)}</div></div>`;
}

// --- activity -----------------------------------------------------------------

const KIND_FILTERS: Array<{ kind: ActivityKind | null; label: string }> = [
  { kind: null, label: "All" },
  { kind: "tool", label: "Agent calls" },
  { kind: "sync", label: "Syncs" },
  { kind: "memory", label: "Memory" },
];

async function renderActivity(runtime: PanelRuntime, url: URL): Promise<string> {
  const now = runtime.now ? runtime.now() : new Date();
  const kindParam = url.searchParams.get("kind");
  const kind = (["tool", "sync", "memory", "system"] as const).find((value) => value === kindParam);
  const errorsOnly = url.searchParams.get("status") === "error";
  const beforeParam = Number(url.searchParams.get("before"));
  const before = Number.isFinite(beforeParam) && beforeParam > 0 ? beforeParam : undefined;
  const entries = await runtime.activity.list({ kind, status: errorsOnly ? "error" : undefined, before, limit: 50 });
  const stats = await runtime.activity.stats(now);

  const query = (next: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { kind, status: errorsOnly ? "error" : undefined, ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value);
    }
    const text = params.toString();
    return `/panel/activity${text ? `?${text}` : ""}`;
  };
  const filters = [
    ...KIND_FILTERS.map((filter) => `<a href="${query({ kind: filter.kind ?? undefined, before: undefined })}" aria-current="${(filter.kind ?? undefined) === kind}">${filter.label}</a>`),
    `<a href="${query({ status: errorsOnly ? undefined : "error", before: undefined })}" aria-current="${errorsOnly}">Errors only</a>`,
  ].join("");
  const older = entries.length === 50 ? `<div class="pager"><a class="button secondary" href="${query({ before: String(entries.at(-1)!.id) })}">Older →</a></div>` : "";
  const top = stats.topTools7d.length
    ? `<p class="muted" style="font-size:13px;margin:0 0 12px">Most used this week: ${stats.topTools7d.map((tool) => `<code>${escapeHtml(tool.name)}</code> ${tool.calls}`).join(" · ")}</p>`
    : "";

  const body = `
    <section class="card"><div class="card-body" style="padding-top:16px">
      <div class="filters">${filters}</div>
      ${top}
      ${renderActivityTable(entries, now, true)}
      ${older}
    </div></section>
    <p class="muted" style="font-size:12.5px">Kept for 30 days. Long text (plan bodies, memory entries, SQL) is stored as its length only. Credentials never reach this log.</p>
    ${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — activity",
    active: "/panel/activity",
    heading: "Activity",
    subtitle: "Every call your agents made to unicorn and every sync unicorn ran, with arguments and timing.",
    body,
    wide: true,
  });
}

function renderActivityTable(entries: ActivityEntry[], now: Date, withDetail: boolean): string {
  if (entries.length === 0) {
    return `<p class="muted">Nothing logged yet.</p>`;
  }
  const rows = entries
    .map((entry) => {
      const who = entry.kind === "tool" ? entry.actor ?? (entry.via === "mcp_token" ? "bearer token" : entry.via ?? "—") : entry.via ?? "—";
      const name = entry.kind === "sync" ? SOURCE_NAMES[entry.name] ?? entry.name : entry.name;
      const summary = summarize(entry);
      const detail = withDetail
        ? `<details><summary>${escapeHtml(summary || "details")}</summary><pre>${escapeHtml(JSON.stringify(entry.detail, null, 2))}</pre></details>`
        : `<span class="muted">${escapeHtml(summary)}</span>`;
      return `<tr>
        <td class="muted" title="${escapeHtml(entry.at)}">${relative(entry.at, now)}</td>
        <td><span class="badge ${entry.kind === "tool" ? "tool" : ""}">${escapeHtml(entry.kind)}</span></td>
        <td><code>${escapeHtml(name)}</code></td>
        <td>${escapeHtml(who)}</td>
        <td>${entry.status === "ok" ? '<span class="badge ok">ok</span>' : `<span class="badge error">${escapeHtml(entry.errorCode ?? "error")}</span>`}</td>
        <td class="num">${entry.durationMs === null ? "" : `${entry.durationMs} ms`}</td>
        <td>${detail}</td>
      </tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>When</th><th>Kind</th><th>What</th><th>Who</th><th>Result</th><th>Time</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function summarize(entry: ActivityEntry): string {
  const detail = entry.detail as Record<string, unknown>;
  if (entry.kind === "sync") {
    return `pulled ${detail.pulled ?? 0} · new ${detail.created ?? 0} · changed ${detail.updated ?? 0} · events ${detail.events ?? 0}`;
  }
  if (entry.kind === "memory") {
    const added = Array.isArray(detail.added) ? (detail.added as string[]).join(", ") : "";
    return detail.status ? `${detail.status}${added ? `: +${added}` : ""}` : String(detail.via ?? "");
  }
  const args = detail.args && typeof detail.args === "object" ? Object.entries(detail.args as Record<string, unknown>) : [];
  const argText = args
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
  const results = typeof detail.results === "number" ? ` → ${detail.results}` : "";
  return `${argText}${results}`.slice(0, 120);
}

// --- memory -------------------------------------------------------------------

async function renderMemoryPage(runtime: PanelRuntime, url: URL): Promise<string> {
  const views = await readAllMemory(runtime.memory);
  const csrf = await computeCsrfToken(runtime.adminToken);
  const saved = url.searchParams.get("saved");
  const error = url.searchParams.get("error");
  const notes = await Promise.all(views.map(async (view) => ({ view, note: await runtime.memory.get(MEMORY_TARGETS[view.target].domain) })));
  const cards = notes.map(({ view, note }) => renderMemoryCard(view, note.content, note.updatedAt, csrf)).join("");
  const body = `
    ${saved ? `<p class="notice">Saved ${escapeHtml(saved)}. Your agents see it from their next session.</p>` : ""}
    ${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ""}
    <section class="card"><div class="card-body" style="padding-top:16px">
      <p style="margin:0;font-size:14px">This is everything your AI agents remember about you. Every new session — Claude on your phone, ChatGPT, Claude Code — starts by reading it. Agents keep it current themselves; you can correct anything here. Separate multi-line entries with a line containing only <code>§</code>.</p>
    </div></section>
    <div class="grid2">${cards}</div>`;
  return renderPage({
    title: "unicorn — memory",
    active: "/panel/memory",
    heading: "Memory",
    subtitle: "Bounded on purpose: small enough to read in full at the start of every session.",
    body,
    wide: true,
  });
}

function renderMemoryCard(view: MemoryView, content: string, updatedAt: string, csrf: string): string {
  const warn = view.usagePercent >= 80 ? " warn" : "";
  const meter = `<div class="meter${warn}"><span style="width:${Math.min(view.usagePercent, 100)}%"></span></div><p class="muted" style="font-size:12px;margin:0">${view.chars}/${view.limit} characters · ${view.updatedAt ? `updated ${timeTag(view.updatedAt)}` : "empty"}</p>`;
  const editor = view.writable
    ? `<form method="post" action="/panel/memory/${view.target}">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="updatedAt" value="${escapeHtml(content ? updatedAt : "")}">
        <textarea name="content" aria-label="${escapeHtml(view.title)}" maxlength="${view.limit + 200}">${escapeHtml(content)}</textarea>
        <div class="actions" style="margin-top:8px;display:flex;justify-content:flex-end"><button type="submit">Save</button></div>
      </form>`
    : `<pre>${escapeHtml(content || "(empty — filled after the first sync)")}</pre><p class="muted" style="font-size:12px">Maintained by unicorn from your synced sources. Tell your agent if something is wrong; it notes it under NOTES.</p>`;
  return `<section class="card"><div class="card-head"><h2>${escapeHtml(view.title)}</h2><p class="card-sub">${escapeHtml(view.purpose)}</p></div><div class="card-body">${meter}${editor}</div></section>`;
}

async function saveMemory(runtime: PanelRuntime, target: MemoryTarget, form: FormData, url: URL): Promise<Response> {
  const content = String(form.get("content") ?? "").replace(/\r\n/g, "\n");
  const updatedAt = String(form.get("updatedAt") ?? "") || undefined;
  const back = (query: string) => new Response(null, { status: 303, headers: { location: new URL(`/panel/memory?${query}`, url).toString() } });
  try {
    await replaceMemory(runtime.memory, target, content, updatedAt);
    await runtime.activity.record({ kind: "memory", name: target, status: "ok", via: "panel", detail: { chars: content.length } }).catch(() => undefined);
    return back(`saved=${encodeURIComponent(MEMORY_TARGETS[target].title)}`);
  } catch (error) {
    const message =
      error instanceof MemoryOperationError
        ? error.message
        : error instanceof MemoryConflictError
          ? "An agent changed this memory while you were editing. Your edit was not saved — reload to see its version."
          : "Memory could not be saved.";
    return back(`error=${encodeURIComponent(message)}`);
  }
}

// --- connect ------------------------------------------------------------------

async function renderConnect(runtime: PanelRuntime, url: URL): Promise<string> {
  const door = runtime.doorUrl;
  const claudeCode = `claude mcp add --transport http unicorn ${door}`;
  const claudeCodeBearer = runtime.bearerToken ? `claude mcp add --transport http unicorn ${door} --header "Authorization: Bearer ${runtime.bearerToken}"` : null;
  const jsonConfig = JSON.stringify({ mcpServers: { unicorn: { type: "http", url: door } } }, null, 2);
  const revoked = url.searchParams.get("revoked");

  const apps = runtime.grants.length
    ? `<ul class="list">${runtime.grants
        .map((grant) => {
          const metadata = grant.metadata as { clientName?: unknown } | null | undefined;
          const name = typeof metadata?.clientName === "string" && metadata.clientName.trim() ? metadata.clientName : grant.clientId;
          return `<li><span>${escapeHtml(name)} <span class="muted">· since ${new Date(grant.createdAt * 1000).toISOString().slice(0, 10)}</span></span>
            <form method="post" action="/settings/oauth/apps/revoke" style="margin:0"><input type="hidden" name="grantId" value="${escapeHtml(grant.id)}"><input type="hidden" name="back" value="panel"><button type="submit" class="secondary">Revoke</button></form></li>`;
        })
        .join("")}</ul>`
    : `<p class="muted">No apps connected yet.</p>`;

  const body = `
    ${revoked ? `<p class="notice">App disconnected.</p>` : ""}
    <section class="card"><div class="card-head"><h2>Your unicorn address</h2><p class="card-sub">Paste it into any app that supports MCP connectors. You sign in once in a pop-up; no token to copy.</p></div>
      <div class="card-body">${copyRow(door)}</div></section>
    <div class="grid2">
      <section class="card"><div class="card-head"><h2>Claude</h2><p class="card-sub">claude.ai, desktop and mobile — one connector everywhere.</p></div><div class="card-body">
        <ol class="steps">
          <li>Open <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">Settings → Connectors</a> and choose <strong>Add custom connector</strong>.</li>
          <li>Name it <code>unicorn</code> and paste your address.</li>
          <li>Click <strong>Connect</strong>. A pop-up opens this site: ${runtime.hosted ? "sign in" : "enter your admin password"} and approve.</li>
          <li>In a chat, enable unicorn under the tools menu and ask <em>“get to know me”</em>.</li>
        </ol></div></section>
      <section class="card"><div class="card-head"><h2>ChatGPT</h2><p class="card-sub">Needs a plan with connectors (developer mode).</p></div><div class="card-body">
        <ol class="steps">
          <li>Open <strong>Settings → Apps &amp; Connectors → Advanced</strong> and turn on developer mode.</li>
          <li><strong>Create</strong> a connector with your address and OAuth authentication.</li>
          <li>Sign in and approve in the pop-up.</li>
        </ol></div></section>
      <section class="card"><div class="card-head"><h2>Claude Code</h2><p class="card-sub">Run once in a terminal; the first call opens the browser to sign in.</p></div><div class="card-body">
        ${copyRow(claudeCode)}
        <p class="muted" style="font-size:13px">Or install the plugin for slash-command playbooks and a session-start hook:</p>
        ${copyRow("/plugin marketplace add TuuHub/unicorn")}
        ${copyRow("/plugin install unicorn")}
      </div></section>
      <section class="card"><div class="card-head"><h2>Cursor, Codex, anything else</h2><p class="card-sub">Standard remote MCP over streamable HTTP with OAuth.</p></div><div class="card-body">
        <pre>${escapeHtml(jsonConfig)}</pre>
      </div></section>
    </div>
    ${
      claudeCodeBearer
        ? `<section class="card" style="margin-top:16px"><div class="card-head"><h2>No OAuth? Use a token</h2><p class="card-sub">For scripts and clients without OAuth support. This is your ${escapeHtml(runtime.bearerLabel)}; treat it like a password.</p></div><div class="card-body">
        <details><summary>Show token commands</summary>${copyRow(claudeCodeBearer)}${copyRow(`Authorization: Bearer ${runtime.bearerToken}`)}</details>
      </div></section>`
        : ""
    }
    <section class="card" style="margin-top:16px"><div class="card-head"><h2>Connected apps</h2><p class="card-sub">Apps you approved. Revoking signs them out immediately.</p></div><div class="card-body">${apps}</div></section>
    ${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — connect",
    active: "/panel/connect",
    heading: "Connect your AI",
    subtitle: "unicorn works inside the AI you already use. Pick yours.",
    body,
    wide: true,
  });
}

function copyRow(value: string): string {
  return `<div class="copy-row"><code>${escapeHtml(value)}</code><button type="button" class="secondary" data-copy="${escapeHtml(value)}">Copy</button></div>`;
}

// --- shared bits --------------------------------------------------------------

function timeTag(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(iso.slice(0, 16).replace("T", " "))} UTC</time>`;
}

export function relative(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.round((then - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const units: Array<[number, string]> = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (abs >= size) {
      const value = Math.round(abs / size);
      const label = `${value} ${name}${value === 1 ? "" : "s"}`;
      return seconds < 0 ? `${label} ago` : `in ${label}`;
    }
  }
  return "just now";
}

const PANEL_SCRIPT = `
<script>
(function () {
  document.querySelectorAll("time[datetime]").forEach(function (node) {
    try { node.textContent = new Date(node.getAttribute("datetime")).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (_) {}
  });
  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var value = button.getAttribute("data-copy") || "";
      var original = button.textContent;
      navigator.clipboard.writeText(value).then(function () { button.textContent = "Copied"; setTimeout(function () { button.textContent = original; }, 1500); });
    });
  });
})();
</script>`;
