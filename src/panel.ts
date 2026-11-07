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
import { clientLabel, clientMark, clientTile, icon, sourceDot, sourceMark, sourceTile } from "./marks";
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
  const [courses, upcoming, unread, stats, recent, memory, csrf] = await Promise.all([
    loadTermCourses(runtime.db).catch((): TermCourse[] => []),
    runtime.repo.upcoming({ days: 7, includeOverdue: false, now }).catch((): ItemSummary[] => []),
    runtime.briefs.list({ unreadOnly: true, limit: 1000 }).catch(() => []),
    runtime.activity.stats(now),
    runtime.activity.list({ limit: 8 }),
    readAllMemory(runtime.memory),
    computeCsrfToken(runtime.adminToken),
  ]);
  const zone = safeZone(runtime.timezone);
  const totalItems = Object.values(runtime.itemCounts).reduce((sum, count) => sum + count, 0);
  const user = memory.find((view) => view.target === "user")!;

  const checklist = [
    { done: runtime.configuredSources > 0, title: "Add a source", text: "Paste an Ed, Moodle, Canvas or Gmail token. Stored encrypted.", href: "/settings", cta: "Sources" },
    { done: totalItems > 0, title: "First sync", text: "Runs hourly; Sync now starts it immediately.", href: "/settings", cta: "Sync now" },
    {
      done: runtime.grants.length > 0 || stats.toolCalls24h > 0 || stats.clients7d.length > 0,
      title: "Connect your AI",
      text: "Claude, ChatGPT, Claude Code or any MCP client.",
      href: "/panel/connect",
      cta: "Connect",
    },
    { done: user.entries.length > 0, title: "Say hi", text: "Ask your agent “get to know me” to fill your profile.", href: "/panel/memory", cta: "Memory" },
  ];
  const doneCount = checklist.filter((step) => step.done).length;
  const setup =
    doneCount === checklist.length
      ? ""
      : `<section class="card setup" aria-labelledby="setup-title">
      <div class="card-head row">
        <div><h2 id="setup-title">Get started</h2><p class="card-sub">${doneCount} of ${checklist.length} done</p></div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${checklist.length}" aria-valuenow="${doneCount}"><span style="width:${(doneCount / checklist.length) * 100}%"></span></div>
      </div>
      <ol class="setup-steps">${checklist
        .map(
          (step, index) => `<li class="${step.done ? "done" : ""}">
          <span class="setup-num" aria-hidden="true">${step.done ? icon("check") : index + 1}</span>
          <div><h3>${step.title}${step.done ? '<span class="sr-only"> (done)</span>' : ""}</h3><p>${step.text}</p>${step.done ? "" : `<a class="more" href="${step.href}">${step.cta}${icon("arrow")}</a>`}</div>
        </li>`,
        )
        .join("")}</ol>
    </section>`;

  const lastSync = runtime.lastCycle.at;
  const stat = (iconName: Parameters<typeof icon>[0], label: string, value: string, hint: string) =>
    `<div class="stat"><div class="stat-label">${icon(iconName)}${escapeHtml(label)}</div><div class="stat-value">${value}</div><div class="stat-hint">${hint}</div></div>`;
  const stats5 = [
    stat("units", "Units this term", String(courses.length), escapeHtml(courses.find((course) => course.term)?.term ?? (courses.length ? "this term" : "after the first sync"))),
    stat("calendar", "Due in 7 days", String(upcoming.length), upcoming[0]?.dueAt ? `next ${escapeHtml(relative(upcoming[0].dueAt, now))}` : "nothing due"),
    stat("spark", "Unread briefs", String(unread.length), "read first each session"),
    stat(
      "agents",
      "Agent calls · 24h",
      String(stats.toolCalls24h),
      stats.errors24h ? `<span class="state bad">${stats.errors24h} error${stats.errors24h === 1 ? "" : "s"}</span>` : `<span class="state">no errors</span>`,
    ),
    stat(
      "sync",
      "Last sync",
      lastSync ? shortAgo(lastSync, now) : "—",
      runtime.schedulerRunning ? `<span class="state">hourly · running</span>` : `<span class="state bad">scheduler stopped</span>`,
    ),
  ].join("");

  const due = renderAgenda(upcoming.slice(0, 10), zone, now);

  const units = courses.length
    ? `<ul class="list">${courses
        .map(
          (course) => `<li>
            <span class="grow unit-row"><span class="badge course">${escapeHtml(course.code)}</span><span class="truncate">${escapeHtml(course.title ?? "")}</span></span>
            <span class="end src-list">${course.sources.map((name) => `<span class="src-chip" title="${escapeHtml(name)}">${sourceDot(name)}${escapeHtml(name)}</span>`).join("")}</span>
          </li>`,
        )
        .join("")}</ul>`
    : empty("units", "Appear after the first sync, and go into your agent's TERM memory.");

  const weekCalls = stats.daily7d.reduce((sum, day) => sum + day.calls, 0);
  const clients = stats.clients7d.length
    ? `<ul class="list clients">${stats.clients7d
        .map((client) => {
          const share = stats.clients7d[0].calls ? Math.max(4, Math.round((client.calls / stats.clients7d[0].calls) * 100)) : 0;
          return `<li>
            <span class="grow">${clientLabel(client.actor, "md")}<span class="bar" aria-hidden="true"><span style="width:${share}%"></span></span></span>
            <span class="end"><strong class="tabular">${client.calls}</strong> call${client.calls === 1 ? "" : "s"}<br>${escapeHtml(relative(client.lastAt, now))}</span>
          </li>`;
        })
        .join("")}</ul>`
    : `${empty("agents", "No agent has called unicorn this week.")}<a class="more" href="/panel/connect">Connect one${icon("arrow")}</a>`;

  const profile = user.entries.length
    ? `<ul class="quotes">${user.entries
        .slice(0, 5)
        .map((entry) => `<li>${escapeHtml(entry)}</li>`)
        .join("")}</ul>`
    : empty("memory", "Nothing yet. Ask your agent “get to know me”.");

  const body = `
    ${setup}
    <div class="stats">${stats5}</div>
    <div class="split">
      <div class="col">
        <section class="card" aria-labelledby="due-title">
          <div class="card-head row"><div class="card-title">${icon("calendar")}<h2 id="due-title">Due this week</h2></div><span class="muted small">${escapeHtml(zone)}</span></div>
          <div class="card-body">${due}</div>
        </section>
        <section class="card" aria-labelledby="recent-title">
          <div class="card-head row"><div class="card-title">${icon("activity")}<h2 id="recent-title">Recent activity</h2></div><a class="more" href="/panel/activity">Full log${icon("arrow")}</a></div>
          <div class="card-body">${renderFeed(recent, now)}</div>
        </section>
      </div>
      <div class="col">
        <section class="card" aria-labelledby="agents-title">
          <div class="card-head row"><div class="card-title">${icon("agents")}<h2 id="agents-title">Your agents</h2></div><span class="muted small tabular">${weekCalls} call${weekCalls === 1 ? "" : "s"} · 7 days</span></div>
          <div class="card-body">${weekCalls ? renderWeekChart(stats.daily7d) : ""}${clients}</div>
        </section>
        <section class="card" aria-labelledby="term-title">
          <div class="card-head row"><div class="card-title">${icon("units")}<h2 id="term-title">This term</h2></div><span class="muted small">kept in TERM memory</span></div>
          <div class="card-body">${units}</div>
        </section>
        <section class="card" aria-labelledby="knows-title">
          <div class="card-head row"><div class="card-title">${icon("memory")}<h2 id="knows-title">What your agent knows</h2></div><a class="more" href="/panel/memory">Edit${icon("arrow")}</a></div>
          <div class="card-body">${profile}</div>
        </section>
      </div>
    </div>
    ${PANEL_STYLE}
    ${PANEL_SCRIPT}`;

  const actions = `<span class="state${!runtime.schedulerRunning ? " bad" : lastSync ? "" : " off"}">${lastSync ? `Synced ${escapeHtml(relative(lastSync, now))}` : "Never synced"}</span>
    <form method="post" action="/settings/sync-now" style="margin:0"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit" class="secondary">${icon("sync")}Sync now</button></form>`;

  return renderPage({
    title: "unicorn — overview",
    active: "/panel",
    heading: greeting(now, zone),
    subtitle: `${escapeHtml(longDate(now, zone))}. ${
      upcoming[0]?.dueAt
        ? `Next due: ${upcoming[0].course ? `${escapeHtml(upcoming[0].course)} ` : ""}${escapeHtml(upcoming[0].title)}, ${escapeHtml(relative(upcoming[0].dueAt, now))}.`
        : "Nothing due in the next 7 days."
    }`,
    body,
    wide: true,
    actions,
  });
}

function renderAgenda(items: ItemSummary[], zone: string, now: Date): string {
  if (items.length === 0) {
    return empty("check", "Nothing due in the next 7 days.");
  }
  const groups = new Map<string, ItemSummary[]>();
  for (const item of items) {
    const key = item.dueAt ? dayKey(item.dueAt, zone) : "";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const today = dayKey(now.toISOString(), zone);
  const tomorrow = dayKey(new Date(now.getTime() + 86_400_000).toISOString(), zone);
  return `<div class="agenda">${[...groups.entries()]
    .map(([key, group]) => {
      const first = group[0].dueAt ?? now.toISOString();
      const label = key === today ? "Today" : key === tomorrow ? "Tomorrow" : formatIn(first, zone, { weekday: "short" });
      return `<div class="day${key === today ? " today" : ""}">
        <div class="day-label"><span class="dow">${escapeHtml(label)}</span><span class="dom tabular">${escapeHtml(formatIn(first, zone, { day: "numeric" }))}</span><span class="mon">${escapeHtml(formatIn(first, zone, { month: "short" }))}</span></div>
        <ul class="list">${group
          .map((item) => {
            const title = item.url ? `<a class="plain" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title);
            const mark = sourceMark(item.source);
            return `<li>
              <span class="grow due-row">${sourceDot(item.source)}${item.course ? `<span class="badge course">${escapeHtml(item.course)}</span>` : ""}<span class="truncate" title="${escapeHtml(item.title)}${mark ? ` · ${mark.name}` : ""}">${title}</span></span>
              <span class="end">${item.dueAt ? escapeHtml(formatIn(item.dueAt, zone, { hour: "2-digit", minute: "2-digit", hour12: false })) : ""}</span>
            </li>`;
          })
          .join("")}</ul>
      </div>`;
    })
    .join("")}</div>`;
}

function renderWeekChart(days: Array<{ day: string; calls: number; errors: number }>): string {
  const max = Math.max(1, ...days.map((day) => day.calls));
  const bars = days
    .map((day, index) => {
      const date = new Date(`${day.day}T12:00:00Z`);
      const label = date.toLocaleDateString("en-AU", { weekday: "narrow", timeZone: "UTC" });
      const full = date.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
      const height = day.calls ? Math.max(6, Math.round((day.calls / max) * 100)) : 0;
      const errorShare = day.calls ? Math.round((day.errors / day.calls) * 100) : 0;
      return `<div class="bar-col${index === days.length - 1 ? " today" : ""}" title="${escapeHtml(full)}: ${day.calls} call${day.calls === 1 ? "" : "s"}${day.errors ? `, ${day.errors} failed` : ""}">
        <div class="bar-track"><span class="bar-fill" style="height:${height}%">${errorShare ? `<span class="bar-err" style="height:${errorShare}%"></span>` : ""}</span></div>
        <span class="bar-label">${escapeHtml(label)}</span>
      </div>`;
    })
    .join("");
  return `<div class="week" role="img" aria-label="Agent calls per day, last 7 days: ${days.map((day) => day.calls).join(", ")}">${bars}</div>`;
}

function renderFeed(entries: ActivityEntry[], now: Date): string {
  if (entries.length === 0) {
    return empty("activity", "Nothing yet. Each agent call and sync appears here as it happens.");
  }
  return `<ul class="list feed">${entries
    .map((entry) => {
      const failed = entry.status !== "ok";
      return `<li${failed ? ' class="failed"' : ""}>
        <span class="grow feed-row">${entryMark(entry)}<span class="feed-text">${feedSentence(entry)}${failed ? ` <span class="badge error">${escapeHtml(entry.errorCode ?? "error")}</span>` : ""}</span></span>
        <span class="end" title="${escapeHtml(entry.at)}">${escapeHtml(shortAgo(entry.at, now))}</span>
      </li>`;
    })
    .join("")}</ul>`;
}

function entryActor(entry: ActivityEntry): string | null {
  if (entry.kind === "tool") return entry.actor ?? (entry.via === "mcp_token" ? "mcp_token" : entry.via);
  if (entry.kind === "memory") return entry.actor ?? entry.via;
  return entry.via;
}

function entryMark(entry: ActivityEntry): string {
  if (entry.kind === "sync") return sourceTile(entry.name, "sm");
  if (entry.kind === "system") return clientTile("scheduler", "sm");
  return clientTile(entryActor(entry), "sm");
}

function feedSentence(entry: ActivityEntry): string {
  const who = `<strong>${escapeHtml(clientName(entryActor(entry)))}</strong>`;
  const summary = summarize(entry);
  if (entry.kind === "tool") {
    return `${who} called <span class="tool">${escapeHtml(entry.name)}</span>${summary ? ` <span class="muted">${escapeHtml(summary)}</span>` : ""}`;
  }
  if (entry.kind === "sync") {
    return `Synced <strong>${escapeHtml(SOURCE_NAMES[entry.name] ?? entry.name)}</strong> <span class="muted">${escapeHtml(summary)}</span>`;
  }
  if (entry.kind === "memory") {
    return `${who} updated <strong>${escapeHtml(memoryTitle(entry.name))}</strong>${summary ? ` <span class="muted">${escapeHtml(summary)}</span>` : ""}`;
  }
  return `<strong>${escapeHtml(entry.name)}</strong>${summary ? ` <span class="muted">${escapeHtml(summary)}</span>` : ""}`;
}

function clientName(actor: string | null): string {
  const mark = clientMark(actor);
  return mark.id === "other" || mark.id === "token" || mark.id === "unicorn" || mark.id === "scheduler" || !actor ? mark.name : actor;
}

// --- activity -----------------------------------------------------------------

const KIND_FILTERS: Array<{ kind: ActivityKind | null; label: string; icon: Parameters<typeof icon>[0] }> = [
  { kind: null, label: "All", icon: "activity" },
  { kind: "tool", label: "Agent calls", icon: "agents" },
  { kind: "sync", label: "Syncs", icon: "sync" },
  { kind: "memory", label: "Memory", icon: "memory" },
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
  const filters = KIND_FILTERS.map(
    (filter) => `<a href="${query({ kind: filter.kind ?? undefined, before: undefined })}" aria-current="${(filter.kind ?? undefined) === kind}">${icon(filter.icon)}${filter.label}</a>`,
  ).join("");
  const errorsToggle = `<div class="filters"><a href="${query({ status: errorsOnly ? undefined : "error", before: undefined })}" aria-current="${errorsOnly}">${icon("alert")}Errors only</a></div>`;
  const older = entries.length === 50 ? `<div class="pager"><a class="button secondary" href="${query({ before: String(entries.at(-1)!.id) })}">Older${icon("arrow")}</a></div>` : "";
  const topMax = stats.topTools7d[0]?.calls ?? 1;
  const top = stats.topTools7d.length
    ? `<section class="card" aria-labelledby="top-title"><div class="card-head row"><div class="card-title">${icon("spark")}<h2 id="top-title">Most used this week</h2></div></div><div class="card-body"><ul class="list tools">${stats.topTools7d
        .map(
          (tool) =>
            `<li><span class="grow"><span class="tool">${escapeHtml(tool.name)}</span><span class="bar" aria-hidden="true"><span style="width:${Math.max(4, Math.round((tool.calls / topMax) * 100))}%"></span></span></span><span class="end tabular">${tool.calls}</span></li>`,
        )
        .join("")}</ul></div></section>`
    : "";
  const statStrip = `<div class="stats">
      <div class="stat"><div class="stat-label">${icon("agents")}Agent calls · 24h</div><div class="stat-value">${stats.toolCalls24h}</div><div class="stat-hint">${stats.errors24h ? `<span class="state bad">${stats.errors24h} failed</span>` : '<span class="state">no errors</span>'}</div></div>
      <div class="stat"><div class="stat-label">${icon("sync")}Syncs · 24h</div><div class="stat-value">${stats.syncs24h}</div><div class="stat-hint">one per source per hour</div></div>
      <div class="stat"><div class="stat-label">${icon("connect")}Clients · 7 days</div><div class="stat-value">${stats.clients7d.length}</div><div class="stat-hint client-stack">${stats.clients7d
        .slice(0, 6)
        .map((client) => clientTile(client.actor, "sm"))
        .join("")}${stats.clients7d.length ? "" : "none yet"}</div></div>
    </div>`;

  const body = `
    ${statStrip}
    <section class="card">
      <div class="card-body" style="padding-top:16px">
        <div class="toolbar"><div class="filters">${filters}</div>${errorsToggle}</div>
        ${renderActivityTable(entries, now)}
        ${older}
      </div>
    </section>
    <div class="grid2 wide-cards">
      ${top}
      <section class="card"><div class="card-head"><div class="card-title">${icon("key")}<h2>What is kept</h2></div></div><div class="card-body"><p class="small muted" style="margin:0">Kept for 30 days. Long text (plan bodies, memory entries, SQL) is stored as its length only. Credentials never reach this log.</p></div></section>
    </div>
    ${PANEL_STYLE}
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

function renderActivityTable(entries: ActivityEntry[], now: Date): string {
  if (entries.length === 0) {
    return empty("activity", "Nothing logged yet.");
  }
  const rows = entries
    .map((entry) => {
      const name = entry.kind === "sync" ? SOURCE_NAMES[entry.name] ?? entry.name : entry.kind === "memory" ? memoryTitle(entry.name) : entry.name;
      const what =
        entry.kind === "tool"
          ? `<span class="tool">${escapeHtml(name)}</span>`
          : `<span class="what">${entry.kind === "sync" ? sourceTile(entry.name, "sm") : `<span class="tile-mark sm mono">${icon(entry.kind === "memory" ? "memory" : "spark", "")}</span>`}${escapeHtml(name)}</span>`;
      const who = entry.kind === "sync" || entry.kind === "system" ? `<span class="who muted">${icon("sync")}${escapeHtml(entry.via ?? "scheduler")}</span>` : clientLabel(entryActor(entry));
      const summary = summarize(entry);
      return `<tr>
        <td class="when" title="${escapeHtml(entry.at)}">${escapeHtml(shortAgo(entry.at, now))}</td>
        <td>${who}</td>
        <td>${what}</td>
        <td>${entry.status === "ok" ? '<span class="state">ok</span>' : `<span class="state bad">${escapeHtml(entry.errorCode ?? "error")}</span>`}</td>
        <td class="num">${entry.durationMs === null ? "" : `${entry.durationMs} ms`}</td>
        <td><details><summary><span>${escapeHtml(summary || "details")}</span></summary><pre>${escapeHtml(JSON.stringify(entry.detail, null, 2))}</pre></details></td>
      </tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Result</th><th class="num">Time</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
    ${saved ? `<p class="notice" role="status">Saved ${escapeHtml(memoryTitle(saved))}. Your agents see it from their next session.</p>` : ""}
    ${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ""}
    <div class="explain">
      <span class="tile-mark lg">${icon("memory", "")}</span>
      <p>Every agent session, in any app on any device, reads all of this first. Agents keep it current; you can edit any of it. A line containing only <code>§</code> separates entries.</p>
    </div>
    <div class="grid2 wide-cards">${cards}</div>
    ${PANEL_STYLE}
    ${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — memory",
    active: "/panel/memory",
    heading: "Memory",
    subtitle: "Size-capped so an agent can read all of it at the start of every session.",
    body,
    wide: true,
  });
}

function renderMemoryCard(view: MemoryView, content: string, updatedAt: string, csrf: string): string {
  const warn = view.usagePercent >= 80 ? " warn" : "";
  const meter = `<div class="mem-meta"><span class="tabular" title="characters used of the limit">${view.chars.toLocaleString("en")} / ${view.limit.toLocaleString("en")}</span><span>${view.updatedAt ? `updated ${timeTag(view.updatedAt)}` : "empty"}</span></div><div class="meter${warn}" role="meter" aria-valuemin="0" aria-valuemax="${view.limit}" aria-valuenow="${view.chars}" aria-label="${escapeHtml(memoryTitle(view.title))} usage"><span style="width:${Math.min(view.usagePercent, 100)}%"></span></div>`;
  const editor = view.writable
    ? `<form method="post" action="/panel/memory/${view.target}">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="updatedAt" value="${escapeHtml(content ? updatedAt : "")}">
        <textarea name="content" aria-label="${escapeHtml(view.title)}" maxlength="${view.limit + 200}" placeholder="Empty. Your agent fills this in as it learns.">${escapeHtml(content)}</textarea>
        <div class="mem-actions"><span class="muted small">${view.entries.length} entr${view.entries.length === 1 ? "y" : "ies"}</span><button type="submit">Save</button></div>
      </form>`
    : `<pre>${escapeHtml(content || "(empty — filled after the first sync)")}</pre><p class="muted small" style="margin:10px 0 0">Maintained by unicorn from your synced sources. Tell your agent if something is wrong; it notes it under Notes.</p>`;
  const tag = view.writable ? `<span class="badge">agents + you</span>` : `<span class="badge">kept by unicorn</span>`;
  return `<section class="card"><div class="card-head row"><div><h2>${escapeHtml(memoryTitle(view.title))}</h2><p class="card-sub">${escapeHtml(capitalize(view.purpose))}</p></div>${tag}</div><div class="card-body">${meter}${editor}</div></section>`;
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
    ? `<ul class="list apps">${runtime.grants
        .map((grant) => {
          const metadata = grant.metadata as { clientName?: unknown } | null | undefined;
          const name = typeof metadata?.clientName === "string" && metadata.clientName.trim() ? metadata.clientName : grant.clientId;
          return `<li><span class="grow">${clientLabel(name, "md")}<span class="muted small since">since ${new Date(grant.createdAt * 1000).toISOString().slice(0, 10)}</span></span>
            <form method="post" action="/settings/oauth/apps/revoke" style="margin:0"><input type="hidden" name="grantId" value="${escapeHtml(grant.id)}"><input type="hidden" name="back" value="panel"><button type="submit" class="secondary sm danger">Revoke</button></form></li>`;
        })
        .join("")}</ul>`
    : empty("connect", "None yet.");

  const works = ["Claude", "ChatGPT", "Claude Code", "Cursor", "Gemini", "GitHub Copilot", "VS Code", "Windsurf", "Zed"];
  const clientCard = (actor: string, title: string, sub: string, content: string, extra = "") => `
      <section class="card client-card">
        <div class="card-head client-head">${extra || clientTile(actor, "lg")}<div><h2>${escapeHtml(title)}</h2><p class="card-sub">${sub}</p></div></div>
        <div class="card-body">${content}</div>
      </section>`;

  const body = `
    ${revoked ? `<p class="notice" role="status">App disconnected.</p>` : ""}
    <section class="card address">
      <div class="card-head row">
        <div><h2>Your unicorn address</h2><p class="card-sub">Paste it as an MCP connector. The app opens a pop-up to sign in; no token needed.</p></div>
      </div>
      <div class="card-body">
        ${copyRow(door)}
        <div class="works"><span class="muted small">Works with</span><span class="works-row">${works.map((name) => `<span title="${escapeHtml(name)}">${clientTile(name, "sm")}</span>`).join("")}<span class="muted small">and any remote MCP client</span></span></div>
      </div>
    </section>
    <div class="grid2 wide-cards">
      ${clientCard(
        "Claude",
        "Claude",
        "claude.ai, desktop and mobile — one connector everywhere.",
        `<ol class="steps">
          <li>Open <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">Settings → Connectors</a> and choose <strong>Add custom connector</strong>.</li>
          <li>Name it <code>unicorn</code> and paste your address.</li>
          <li>Click <strong>Connect</strong>. A pop-up opens this site: ${runtime.hosted ? "sign in" : "enter your admin password"} and approve.</li>
          <li>In a chat, enable unicorn under the tools menu and ask <em>“get to know me”</em>.</li>
        </ol>`,
      )}
      ${clientCard(
        "ChatGPT",
        "ChatGPT",
        "Needs a plan with connectors (developer mode).",
        `<ol class="steps">
          <li>Open <strong>Settings → Apps &amp; Connectors → Advanced</strong> and turn on developer mode.</li>
          <li><strong>Create</strong> a connector with your address and OAuth authentication.</li>
          <li>Sign in and approve in the pop-up.</li>
        </ol>`,
      )}
      ${clientCard(
        "Claude Code",
        "Claude Code",
        "Run once in a terminal; the first call opens the browser to sign in.",
        `${copyRow(claudeCode, true)}
        <p class="muted small" style="margin:14px 0 0">Or install the plugin for slash-command playbooks and a session-start hook:</p>
        ${copyRow("/plugin marketplace add TuuHub/unicorn")}
        ${copyRow("/plugin install unicorn")}`,
      )}
      ${clientCard(
        "",
        "Cursor, Codex, anything else",
        "Standard remote MCP over streamable HTTP with OAuth.",
        `<pre class="night">${escapeHtml(jsonConfig)}</pre>`,
        `<span class="tile-cluster">${["Cursor", "Codex", "VS Code", "Windsurf"].map((name) => clientTile(name, "md")).join("")}</span>`,
      )}
    </div>
    ${
      claudeCodeBearer
        ? `<section class="card" style="margin-top:16px"><div class="card-head"><div class="card-title">${icon("key")}<h2>No OAuth? Use a token</h2></div><p class="card-sub">For scripts and clients without OAuth support. This is your ${escapeHtml(runtime.bearerLabel)}; treat it like a password.</p></div><div class="card-body">
        <details><summary><span>Show token commands</span></summary>${copyRow(claudeCodeBearer, true)}${copyRow(`Authorization: Bearer ${runtime.bearerToken}`)}</details>
      </div></section>`
        : ""
    }
    <section class="card" style="margin-top:16px"><div class="card-head row"><div><div class="card-title">${icon("agents")}<h2>Connected apps</h2></div><p class="card-sub">Apps you approved. Revoking signs them out immediately.</p></div><span class="badge tabular">${runtime.grants.length}</span></div><div class="card-body">${apps}</div></section>
    ${PANEL_STYLE}
    ${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — connect",
    active: "/panel/connect",
    heading: "Connect your AI",
    subtitle: "One address for every client. Each app signs in once and can be revoked below.",
    body,
    wide: true,
  });
}

function copyRow(value: string, shell = false): string {
  return `<div class="cmd"><code>${shell ? '<span class="prompt">$ </span>' : ""}${escapeHtml(value)}</code><button type="button" data-copy="${escapeHtml(value)}" aria-label="Copy">${icon("copy")}<span>Copy</span></button></div>`;
}

// --- shared bits --------------------------------------------------------------

function empty(iconName: Parameters<typeof icon>[0], text: string): string {
  return `<div class="empty">${icon(iconName)}<p>${text}</p></div>`;
}

function memoryTitle(value: string): string {
  const known: Record<string, string> = { "USER PROFILE": "User profile", NOTES: "Notes", TERM: "Term", user: "User profile", notes: "Notes", corrections: "Corrections", term: "Term" };
  return known[value] ?? capitalize(value.toLowerCase());
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function timeTag(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(iso.slice(0, 16).replace("T", " "))} UTC</time>`;
}

function safeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

function formatIn(iso: string, zone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-AU", { ...options, timeZone: zone }).format(new Date(iso));
}

function dayKey(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone }).format(new Date(iso));
}

function greeting(now: Date, zone: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-AU", { hour: "numeric", hour12: false, timeZone: zone }).format(now)) % 24;
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function longDate(now: Date, zone: string): string {
  return formatIn(now.toISOString(), zone, { weekday: "long", day: "numeric", month: "long" });
}

/** "12m", "3h", "2d": for stat values and table cells where a sentence won't fit. */
function shortAgo(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
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

// Page-level layout the shared shell doesn't need: the agenda, the week chart, the feed, the
// setup strip and the client cards.
const PANEL_STYLE = `<style>
.small{font-size:12.5px}
.setup .card-head{align-items:center}
.progress{width:140px;height:6px;border-radius:999px;background:var(--paper-2);border:1px solid var(--rule-2);overflow:hidden;flex:none}
.progress>span{display:block;height:100%;background:var(--ink);border-radius:999px}
.setup-steps{list-style:none;margin:0;padding:16px 20px 20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:12px}
.setup-steps li{display:flex;gap:12px;padding:14px;border:1px solid var(--rule-2);border-radius:12px;background:var(--paper)}
.setup-steps h3{font-size:14px}
.setup-steps p{margin:3px 0 8px;color:var(--ink-2);font-size:13px}
.setup-steps li.done{opacity:.62}
.setup-steps li.done p{margin-bottom:0}
.setup-num{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:50%;border:1px solid var(--rule);background:var(--chip);font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink-2)}
.setup-num .i{width:14px;height:14px}
.done .setup-num{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.agenda{display:flex;flex-direction:column}
.day{display:grid;grid-template-columns:64px minmax(0,1fr);gap:12px;padding:12px 0;border-top:1px solid var(--rule-2)}
.day:first-child{border-top:0;padding-top:2px}
.day-label{display:flex;flex-direction:column;line-height:1.15;padding-top:2px}
.dow{font-size:12px;font-weight:500;color:var(--ink-2)}
.dom{font-size:22px;font-weight:600;letter-spacing:-.03em}
.mon{font-size:11.5px;color:var(--ink-3)}
.day.today .dow{color:var(--ink);font-weight:600}
.day .list>li{padding:7px 0}
.day .list>li:first-child{padding-top:2px}
.due-row,.unit-row{display:flex;align-items:center;gap:8px;min-width:0}
.due-row a:hover{text-decoration:underline;text-decoration-color:var(--ink-3);text-underline-offset:3px}
.src-list{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
.src-chip{display:inline-flex;align-items:center;gap:5px;color:var(--ink-2)}
.week{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;height:96px;margin:4px 0 14px}
.bar-col{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0}
.bar-track{flex:1;width:100%;display:flex;align-items:flex-end;border-bottom:1px solid var(--rule)}
.bar-fill{position:relative;display:flex;flex-direction:column;justify-content:flex-start;width:100%;max-width:28px;margin:0 auto;background:color-mix(in srgb,var(--ink) 22%,var(--surface));border-radius:5px 5px 0 0;overflow:hidden}
.bar-col.today .bar-fill{background:var(--ink)}
.bar-err{display:block;width:100%;background:var(--bad)}
.bar-label{font-size:11px;color:var(--ink-3)}
.bar-col.today .bar-label{color:var(--ink);font-weight:600}
.clients .bar{margin-left:38px}
.bar{display:block;height:3px;margin-top:7px;border-radius:999px;background:var(--paper-2);overflow:hidden;max-width:220px}
.bar>span{display:block;height:100%;background:var(--ink-3);border-radius:999px}
.clients>li{align-items:center}
.clients .grow{display:flex;flex-direction:column;align-items:stretch}
.clients .end{line-height:1.45}
.clients .end strong{color:var(--ink);font-weight:600}
.tools .grow{display:flex;flex-direction:column}
.quotes{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.quotes li{position:relative;padding:2px 0 2px 14px;font-size:14px;color:var(--ink)}
.quotes li::before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:2px;border-radius:2px;background:var(--rule)}
.feed-row{display:flex;align-items:center;gap:10px;min-width:0}
.feed-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
.feed-text strong{font-weight:600}
.feed .muted{color:var(--ink-3)}
.client-stack{gap:0}
.client-stack .tile-mark{margin-right:-4px;box-shadow:0 0 0 2px var(--surface)}
.explain{display:flex;gap:14px;align-items:flex-start;margin-bottom:16px;padding:16px 18px;border:1px solid var(--rule);border-radius:14px;background:var(--paper-2)}
.explain p{margin:0;font-size:14px;color:var(--ink-2)}
.mem-meta{display:flex;justify-content:space-between;gap:12px;color:var(--ink-3);font-size:12px;margin-bottom:6px;white-space:nowrap}
.wide-cards{grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))}
.mem-actions{display:flex;justify-content:space-between;align-items:center;margin-top:10px}
.address .card-body{padding-top:8px}
.address .cmd{padding:8px 8px 8px 16px}
.address .cmd code{font-size:14px}
.works{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px}
.works-row{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.client-card{display:flex;flex-direction:column}
.client-head{display:flex;align-items:center;gap:14px;padding-bottom:4px}
.tile-cluster{display:inline-flex;flex:none}
.tile-cluster .tile-mark{margin-right:-8px;box-shadow:0 0 0 2px var(--surface)}
.tile-cluster .tile-mark:last-child{margin-right:0}
.apps .grow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.since{white-space:nowrap}
</style>`;

const PANEL_SCRIPT = `
<script>
(function () {
  document.querySelectorAll("time[datetime]").forEach(function (node) {
    try { node.textContent = new Date(node.getAttribute("datetime")).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (_) {}
  });
  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var value = button.getAttribute("data-copy") || "";
      var label = button.querySelector("span") || button;
      var original = label.textContent;
      navigator.clipboard.writeText(value).then(function () { label.textContent = "Copied"; setTimeout(function () { label.textContent = original; }, 1500); });
    });
  });
})();
</script>`;
