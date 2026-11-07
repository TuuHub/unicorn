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
import {
  capitalize,
  copyRow,
  dayKey,
  empty,
  formatIn,
  longDate,
  MEMORY_PURPOSE,
  memoryTitle,
  PANEL_SCRIPT,
  PANEL_STYLE,
  relative,
  safeZone,
  shortAgo,
  SOURCE_NAMES,
  timeTag,
} from "./panel-kit";
import {
  CAMPUS_STYLE,
  markBriefsRead,
  recentChanges,
  renderChangeDays,
  renderBriefs,
  renderChanges,
  renderDeadlines,
  renderDeadlinesIcs,
  renderPlans,
  renderSearch,
  renderUnit,
  renderUnits,
  togglePlanItem,
} from "./panel-campus";
import { type DeploymentInfo, renderDeployment, renderExport, renderPlaybooks } from "./panel-setup";
import { escapeHtml, htmlResponse, renderPage } from "./ui";

export { relative } from "./panel-kit";

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
  // Self-deployed Workers only (src/index.ts); the hosted server leaves it unset and has no
  // Deployment page.
  deployment?: DeploymentInfo;
  now?: () => Date;
}



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
    if (path === "/panel/briefs/read") return markBriefsRead(runtime, form, url);
    if (path === "/panel/plans/toggle") return togglePlanItem(runtime, form, url);
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
    case "/panel/changes":
      return htmlResponse(await renderChanges(runtime, url));
    case "/panel/due":
      return htmlResponse(await renderDeadlines(runtime, url));
    case "/panel/due.ics":
      return renderDeadlinesIcs(runtime, url);
    case "/panel/units":
      return htmlResponse(await renderUnits(runtime));
    case "/panel/briefs":
      return htmlResponse(await renderBriefs(runtime, url));
    case "/panel/plans":
      return htmlResponse(await renderPlans(runtime, url));
    case "/panel/search":
      return htmlResponse(await renderSearch(runtime, url));
    case "/panel/playbooks":
      return htmlResponse(await renderPlaybooks(runtime));
    case "/panel/export":
      return renderExport(runtime);
    case "/panel/deployment": {
      const page = await renderDeployment(runtime);
      return page ? htmlResponse(page) : new Response(null, { status: 303, headers: { location: new URL("/account", url).toString() } });
    }
    default: {
      const unit = path.match(/^\/panel\/units\/([A-Za-z0-9._-]{2,24})$/);
      if (unit) {
        const page = await renderUnit(runtime, decodeURIComponent(unit[1]));
        if (page) return htmlResponse(page);
      }
      return new Response("Not found.", { status: 404 });
    }
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
  const changes = await recentChanges(runtime.db, { limit: 6 }).catch(() => []);
  const zone = safeZone(runtime.timezone);
  const totalItems = Object.values(runtime.itemCounts).reduce((sum, count) => sum + count, 0);
  const user = memory.find((view) => view.target === "user")!;

  const checklist = [
    {
      done: runtime.configuredSources > 0,
      title: "Add a source",
      text: runtime.hosted ? "Ed, Moodle, Canvas or Gmail. Tokens are stored encrypted." : "Paste a token in Sources, or set it with wrangler secret put.",
      href: "/settings",
      cta: "Sources",
    },
    { done: totalItems > 0, title: "First sync", text: "Automatic every hour, or start it now.", href: "/settings", cta: "Sync now" },
    {
      done: runtime.grants.length > 0 || stats.toolCalls24h > 0 || stats.clients7d.length > 0,
      title: "Connect your AI",
      text: "Claude, ChatGPT, Claude Code or any MCP client.",
      href: "/panel/connect",
      cta: "Connect",
    },
    { done: user.entries.length > 0, title: "Introduce yourself", text: "Ask your agent “get to know me”; it writes your profile.", href: "/panel/memory", cta: "Profile" },
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
  const dueUnits = new Set(upcoming.map((item) => item.course ?? item.source)).size;
  const stat = (iconName: Parameters<typeof icon>[0], label: string, value: string, hint: string, href: string) =>
    `<a class="stat" href="${href}"><div class="stat-label">${icon(iconName)}${escapeHtml(label)}</div><div class="stat-value">${value}</div><div class="stat-hint">${hint}</div></a>`;
  const stats5 = [
    stat("units", "Units this term", String(courses.length), escapeHtml(courses.find((course) => course.term)?.term ?? (courses.length ? "this term" : "after the first sync")), "/panel/units"),
    stat("calendar", "Due in 7 days", String(upcoming.length), upcoming.length ? `across ${dueUnits} unit${dueUnits === 1 ? "" : "s"}` : "nothing due", "/panel/due"),
    stat("brief", "Unread briefs", String(unread.length), "agents read these first", "/panel/briefs"),
    stat(
      "agents",
      "Agent calls · 24h",
      String(stats.toolCalls24h),
      stats.errors24h ? `<span class="state bad">${stats.errors24h} error${stats.errors24h === 1 ? "" : "s"}</span>` : `<span class="state">no errors</span>`,
      "/panel/activity",
    ),
    stat(
      "sync",
      "Last sync",
      lastSync ? shortAgo(lastSync, now) : "—",
      runtime.schedulerRunning ? `<span class="state">hourly · running</span>` : `<span class="state bad">scheduler stopped</span>`,
      "/settings",
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
    : empty("units", "Units appear after the first sync.");

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
    : `${empty("agents", "No calls in the last 7 days.")}<a class="more" href="/panel/connect">Connect one${icon("arrow")}</a>`;

  const profile = user.entries.length
    ? `<ul class="quotes">${user.entries
        .slice(0, 5)
        .map((entry) => `<li>${escapeHtml(entry)}</li>`)
        .join("")}</ul>`
    : empty("memory", "Empty. Ask your agent “get to know me”.");

  const body = `
    ${setup}
    <div class="stats">${stats5}</div>
    <div class="split">
      <div class="col">
        <section class="card" aria-labelledby="due-title">
          <div class="card-head row"><div class="card-title">${icon("calendar")}<h2 id="due-title">Due this week</h2></div><span class="muted small">${escapeHtml(zone)}</span></div>
          <div class="card-body">${due}</div>
        </section>
        <section class="card" aria-labelledby="changes-title">
          <div class="card-head row"><div class="card-title">${icon("changes")}<h2 id="changes-title">Latest changes</h2></div><a class="more" href="/panel/changes">All${icon("arrow")}</a></div>
          <div class="card-body">${changes.length ? renderChangeDays(changes, zone, now) : empty("changes", "No changes yet.")}</div>
        </section>
        <section class="card" aria-labelledby="recent-title">
          <div class="card-head row"><div class="card-title">${icon("activity")}<h2 id="recent-title">Recent activity</h2></div><a class="more" href="/panel/activity">Full log${icon("arrow")}</a></div>
          <div class="card-body">${renderFeed(recent, now)}</div>
        </section>
      </div>
      <div class="col">
        ${
          unread.length
            ? `<section class="card" aria-labelledby="briefs-title"><div class="card-head row"><div class="card-title">${icon("brief")}<h2 id="briefs-title">Unread briefs</h2></div><a class="more" href="/panel/briefs">Read${icon("arrow")}</a></div><div class="card-body"><ul class="list">${unread
                .slice(0, 4)
                .map((brief) => `<li><a class="grow plain truncate" href="/panel/briefs">${escapeHtml(brief.title)}</a><span class="end">${escapeHtml(shortAgo(brief.createdAt, now))}</span></li>`)
                .join("")}</ul></div></section>`
            : ""
        }
        <section class="card" aria-labelledby="agents-title">
          <div class="card-head row"><div class="card-title">${icon("agents")}<h2 id="agents-title">Your agents</h2></div><span class="muted small tabular">${weekCalls} call${weekCalls === 1 ? "" : "s"} · 7 days</span></div>
          <div class="card-body">${weekCalls ? renderWeekChart(stats.daily7d) : ""}${clients}</div>
        </section>
        <section class="card" aria-labelledby="term-title">
          <div class="card-head row"><div class="card-title">${icon("units")}<h2 id="term-title">This term</h2></div></div>
          <div class="card-body">${units}</div>
        </section>
        <section class="card" aria-labelledby="knows-title">
          <div class="card-head row"><div class="card-title">${icon("memory")}<h2 id="knows-title">Your profile</h2></div><a class="more" href="/panel/memory">Edit${icon("arrow")}</a></div>
          <div class="card-body">${profile}</div>
        </section>
      </div>
    </div>
    ${PANEL_STYLE}${CAMPUS_STYLE}
    ${PANEL_SCRIPT}`;

  const actions = `<form method="post" action="/settings/sync-now" style="margin:0"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit" class="secondary">${icon("sync")}Sync now</button></form>`;

  return renderPage({
    title: "unicorn — overview",
    active: "/panel",
    heading: escapeHtml(longDate(now, zone)),
    subtitle: upcoming[0]?.dueAt
      ? `Next due ${escapeHtml(relative(upcoming[0].dueAt, now))}: ${upcoming[0].course ? `${escapeHtml(upcoming[0].course)} ` : ""}${escapeHtml(upcoming[0].title)}.`
      : "Nothing due in the next 7 days.",
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
    return empty("activity", "No activity yet.");
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
    ${top}
    ${PANEL_STYLE}
    ${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — activity",
    active: "/panel/activity",
    heading: "Activity",
    subtitle: "Every agent call and source sync from the last 30 days, with arguments, timing and errors. Long text is stored as its length; credentials are never logged.",
    body,
    wide: true,
  });
}

function renderActivityTable(entries: ActivityEntry[], now: Date): string {
  if (entries.length === 0) {
    return empty("activity", "Nothing matches.");
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
    <div class="grid2 wide-cards">${cards}</div>
    ${PANEL_STYLE}
    ${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — memory",
    active: "/panel/memory",
    heading: "Memory",
    subtitle: "Every agent session, in any app, reads all of this first. Agents keep it current; you can correct it here.",
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
        <div class="mem-actions"><span class="muted small">${view.entries.length} entr${view.entries.length === 1 ? "y" : "ies"} · a line with only <code>§</code> separates them</span><button type="submit">Save</button></div>
      </form>`
    : `<pre>${escapeHtml(content || "(empty — filled after the first sync)")}</pre><p class="muted small" style="margin:10px 0 0">If it's wrong, tell your agent; it records the fix in Notes.</p>`;
  const tag = view.writable ? "" : `<span class="badge">Read-only</span>`;
  return `<section class="card"><div class="card-head row"><div><h2>${escapeHtml(memoryTitle(view.title))}</h2><p class="card-sub">${escapeHtml(MEMORY_PURPOSE[view.target] ?? capitalize(view.purpose))}</p></div>${tag}</div><div class="card-body">${meter}${editor}</div></section>`;
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
        <div><h2>Your unicorn address</h2><p class="card-sub">Add it as a custom MCP connector. The app opens a sign-in pop-up; no token needed.</p></div>
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
        "One connector covers claude.ai, desktop and mobile.",
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
        "Needs developer mode, on plans with connectors.",
        `<ol class="steps">
          <li>Open <strong>Settings → Apps &amp; Connectors → Advanced</strong> and turn on developer mode.</li>
          <li><strong>Create</strong> a connector with your address and OAuth authentication.</li>
          <li>Sign in and approve in the pop-up.</li>
        </ol>`,
      )}
      ${clientCard(
        "Claude Code",
        "Claude Code",
        "Run once. The first call opens a browser to sign in.",
        `${copyRow(claudeCode, true)}
        <p class="muted small" style="margin:14px 0 0">Or the plugin, which adds playbook slash commands and a session-start hook:</p>
        ${copyRow("/plugin marketplace add TuuHub/unicorn")}
        ${copyRow("/plugin install unicorn")}`,
      )}
      ${clientCard(
        "",
        "Cursor, Codex, anything else",
        "Remote MCP over streamable HTTP, OAuth sign-in.",
        `<pre class="night">${escapeHtml(jsonConfig)}</pre>`,
        `<span class="tile-cluster">${["Cursor", "Codex", "VS Code", "Windsurf"].map((name) => clientTile(name, "md")).join("")}</span>`,
      )}
    </div>
    ${
      claudeCodeBearer
        ? `<section class="card" style="margin-top:16px"><div class="card-head"><div class="card-title">${icon("key")}<h2>No OAuth? Use a token</h2></div><p class="card-sub">For scripts and clients without OAuth. This is your ${escapeHtml(runtime.bearerLabel)}: treat it as a password.</p></div><div class="card-body">
        <details><summary><span>Show token commands</span></summary>${copyRow(claudeCodeBearer, true)}${copyRow(`Authorization: Bearer ${runtime.bearerToken}`)}</details>
      </div></section>`
        : ""
    }
    ${
      runtime.hosted
        ? ""
        : `<section class="card" style="margin-top:16px"><div class="card-head"><div class="card-title">${icon("server")}<h2>Admin MCP</h2></div><p class="card-sub">Raw items, relations, plugin manifests and custom tools, for maintaining this Worker. Bearer ADMIN_TOKEN only; never give it to an everyday chat.</p></div><div class="card-body">
        ${copyRow(`claude mcp add --transport http unicorn-admin ${new URL("/mcp/admin", runtime.doorUrl).toString()} --header "Authorization: Bearer <ADMIN_TOKEN>"`, true)}
      </div></section>`
    }
    <section class="card" style="margin-top:16px"><div class="card-head row"><div><div class="card-title">${icon("agents")}<h2>Connected apps</h2></div><p class="card-sub">Revoking signs an app out immediately.</p></div><span class="badge tabular">${runtime.grants.length}</span></div><div class="card-body">${apps}</div></section>
    ${PANEL_STYLE}
    ${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — connect",
    active: "/panel/connect",
    heading: "Connect your AI",
    subtitle: "One address works in every MCP client. Each app signs in once; revoke it at the bottom.",
    body,
    wide: true,
  });
}
