// The panel's agent and setup pages (ADR-0048):
//
//   /panel/playbooks    what each playbook does, how to start it, and which run on a schedule
//   /panel/deployment   self-deployed Workers only: health, endpoints, secrets, upgrading
//   /panel/export       everything unicorn keeps about you that isn't a synced copy, as JSON
//
// The hosted server has no Deployment page; its account page (server/pages.ts) says where the
// data lives and links the same export.

import { readAllMemory } from "./agent-memory";
import { icon } from "./marks";
import type { PanelRuntime } from "./panel";
import { copyRow, formatIn, PANEL_SCRIPT, PANEL_STYLE, relative, safeZone } from "./panel-kit";
import { PLAYBOOKS } from "./playbooks";
import { computeCsrfToken } from "./settings";
import { escapeHtml, renderPage } from "./ui";

/** Self-deployed Worker facts for /panel/deployment. The hosted server leaves this unset. */
export interface DeploymentInfo {
  origin: string;
  database: boolean;
  bindings: Record<string, boolean>; // binding or secret name → present
  retentionDays: number;
  syncEnabled: boolean;
}

// Playbook descriptions are written for the agent ("Use when the user …"); these are for the person.
const PLAYBOOK_COPY: Record<string, { ask: string; does: string }> = {
  "catch-up": { ask: "I was sick last week, catch me up.", does: "Every change since you were away, ranked into act now, read soon and background, with a 7-day recovery plan." },
  "decompose-assignment": { ask: "Break FIT2004 Assignment 3 into daily tasks.", does: "Reads the assessment and everything filed under it, then saves a dated task list as an assignment plan." },
  "exam-prep": { ask: "Help me prep for the FIT2004 exam.", does: "Collects exam notices, staff hints and assessments for one unit and builds a revision plan up to the exam." },
  "forum-brief": { ask: "What did staff post on the forums today?", does: "Staff notices and answers since the last forum brief, per unit." },
  onboard: { ask: "Get to know me.", does: "Reads your units, asks a few questions, and writes your profile and first notes to memory." },
  triage: { ask: "Sort my unsorted items.", does: "Files items that have no assignment group yet, leaving ambiguous ones for you." },
  "weekly-plan": { ask: "Plan my week.", does: "A 7-day checklist from due dates across every unit, saved as this week's plan." },
};

export async function renderPlaybooks(runtime: PanelRuntime): Promise<string> {
  const runs = await runtime.db
    .prepare("SELECT kind, MAX(created_at) AS last, COUNT(*) AS n FROM briefs GROUP BY kind")
    .all<{ kind: string; last: string; n: number }>()
    .then((rows) => new Map(rows.results.map((row) => [row.kind, row])))
    .catch(() => new Map<string, { kind: string; last: string; n: number }>());
  const now = runtime.now ? runtime.now() : new Date();
  const cards = PLAYBOOKS.map((playbook) => {
    const copy = PLAYBOOK_COPY[playbook.id] ?? { ask: playbook.title, does: playbook.description };
    const schedule = playbook.trigger
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part && part !== "on-demand");
    const last = runs.get(playbook.id);
    const args = playbook.arguments.length
      ? `<p class="muted small" style="margin:10px 0 0">Takes ${playbook.arguments.map((arg) => `<code>${escapeHtml(arg.name)}</code>${arg.required ? "" : " (optional)"}`).join(", ")}.</p>`
      : "";
    return `<section class="card playbook">
      <div class="card-head row"><div class="card-title"><span class="tile-mark md mono">${icon("playbook", "")}</span><div><h2>${escapeHtml(playbook.title)}</h2><p class="card-sub" style="margin:0">Produces ${escapeHtml(playbook.output)}</p></div></div>
        <span class="pb-tags">${schedule.map((part) => `<span class="badge">${icon(part.startsWith("routine") ? "clock" : "spark")}${escapeHtml(part.replace(/^routine /, ""))}</span>`).join("")}</span></div>
      <div class="card-body">
        <p class="pb-does">${escapeHtml(copy.does)}</p>
        <div class="cmd ask"><code>“${escapeHtml(copy.ask)}”</code><button type="button" data-copy="${escapeHtml(copy.ask)}" aria-label="Copy">${icon("copy")}<span>Copy</span></button></div>
        ${args}
        <p class="pb-foot muted small">MCP prompt <code>${escapeHtml(playbook.id)}</code>${last ? ` · last brief ${escapeHtml(relative(last.last, now))} · ${last.n} filed` : ""}</p>
      </div>
    </section>`;
  }).join("");
  const body = `
    <div class="grid2 wide-cards">${cards}</div>
    <style>
      .playbook .card-head{align-items:flex-start}
      .pb-tags{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      .pb-tags .badge .i{width:12px;height:12px}
      .pb-does{margin:0 0 10px;font-size:14px;color:var(--ink-2)}
      .ask code{font-family:inherit;font-size:13.5px}
      .pb-foot{margin:10px 0 0}
    </style>
    ${PANEL_STYLE}${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — playbooks",
    active: "/panel/playbooks",
    heading: "Playbooks",
    subtitle: "Step-by-step procedures your agent follows. Say the line, or pick the prompt from your app's prompt menu. Scheduled ones run on their own and file a brief.",
    body,
    wide: true,
  });
}

export async function renderDeployment(runtime: PanelRuntime): Promise<string | null> {
  const info = runtime.deployment;
  if (!info) return null;
  const now = runtime.now ? runtime.now() : new Date();
  const zone = safeZone(runtime.timezone);
  const csrf = await computeCsrfToken(runtime.adminToken);
  const host = new URL(info.origin).host;
  const row = (ok: boolean, label: string, value: string, extra = "") =>
    `<li><span class="grow">${label}</span><span class="end">${extra}<span class="state${ok ? "" : " bad"}">${value}</span></span></li>`;
  const health = `<ul class="list">
    ${row(info.database, "D1 database", info.database ? "Answering" : "Not answering")}
    ${row(runtime.schedulerRunning, "Hourly scheduler", runtime.schedulerRunning ? "Running" : "Stopped", runtime.schedulerRunning ? "" : `<form method="post" action="/settings/start-scheduler" style="margin:0 10px 0 0;display:inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit" class="sm">Start</button></form>`)}
    ${row(Boolean(runtime.lastCycle.at), "Last cycle", runtime.lastCycle.at ? `${escapeHtml(relative(runtime.lastCycle.at, now))}` : "Never run")}
    ${row(info.syncEnabled, "Source sync", info.syncEnabled ? "On" : "Off in Sources")}
  </ul>`;
  const endpoints = [
    ["Panel", "/panel", "Basic auth: user unicorn, password ADMIN_TOKEN"],
    ["Door (MCP)", "/mcp", "OAuth sign-in, or Bearer MCP_TOKEN"],
    ["Admin MCP", "/mcp/admin", "Bearer ADMIN_TOKEN only: raw items, relations, plugin manifests, custom tools"],
    ["Health", "/health", "Public JSON: database and scheduler"],
  ]
    .map(([name, path, auth]) => `<li><span class="grow"><strong>${name}</strong><br><span class="muted small">${auth}</span></span><code class="end-code">${escapeHtml(host)}${path}</code></li>`)
    .join("");
  const bindings = Object.entries(info.bindings)
    .map(([name, present]) => `<li><span class="grow"><code>${escapeHtml(name)}</code></span><span class="state${present ? "" : " off"}">${present ? "Set" : "Not set"}</span></li>`)
    .join("");
  const body = `
    <div class="grid2 wide-cards">
      <section class="card"><div class="card-head"><div class="card-title">${icon("server")}<h2>Health</h2></div><p class="card-sub">Checked when this page loaded, ${escapeHtml(formatIn(now.toISOString(), zone, { hour: "2-digit", minute: "2-digit", hour12: false }))}.</p></div><div class="card-body">${health}</div></section>
      <section class="card"><div class="card-head"><div class="card-title">${icon("key")}<h2>Secrets and bindings</h2></div><p class="card-sub">Presence only; values never leave the Worker. Set with <code>wrangler secret put</code>.</p></div><div class="card-body"><ul class="list">${bindings}</ul></div></section>
    </div>
    <section class="card"><div class="card-head"><div class="card-title">${icon("connect")}<h2>Endpoints</h2></div></div><div class="card-body"><ul class="list endpoints">${endpoints}</ul></div></section>
    <div class="grid2 wide-cards">
      <section class="card"><div class="card-head"><div class="card-title">${icon("sync")}<h2>Upgrade</h2></div><p class="card-sub">From your clone: pull, apply new migrations, redeploy. Data and secrets carry over.</p></div><div class="card-body">
        ${copyRow("git pull", true)}${copyRow("npm ci", true)}${copyRow("npm run upgrade", true)}
        <p class="muted small" style="margin:10px 0 0"><a href="https://unicorn.tuuhub.com/docs/unicorn/upgrade" target="_blank" rel="noopener">Upgrade notes</a> list anything a release needs by hand.</p>
      </div></section>
      <section class="card"><div class="card-head"><div class="card-title">${icon("download")}<h2>Your data</h2></div><p class="card-sub">Everything lives in this Worker's D1 database, on your Cloudflare account. Non-course items move to the archive after ${info.retentionDays} days.</p></div><div class="card-body">
        <a class="button secondary" href="/panel/export" download>${icon("download")}Export memory, plans, briefs, activity (JSON)</a>
        <p class="muted small" style="margin:12px 0 0">A full backup, synced items included: <code>wrangler d1 export unicorn --remote --output backup.sql</code></p>
      </div></section>
    </div>
    <style>
      .endpoints .grow{line-height:1.45}
      .end-code{flex:none;font-size:12px}
      @media (max-width:640px){.endpoints>li{flex-direction:column;align-items:flex-start}}
    </style>
    ${PANEL_STYLE}${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — deployment",
    active: "/panel/deployment",
    heading: "Deployment",
    subtitle: `Your Worker at ${escapeHtml(host)}, on your own Cloudflare account. Nobody else holds your tokens or data.`,
    body,
    wide: true,
  });
}

export async function renderExport(runtime: PanelRuntime): Promise<Response> {
  const now = runtime.now ? runtime.now() : new Date();
  const all = async <T>(sql: string): Promise<T[]> =>
    runtime.db
      .prepare(sql)
      .all<T>()
      .then((rows) => rows.results)
      .catch((): T[] => []);
  const [memory, plans, briefs, activity] = await Promise.all([
    readAllMemory(runtime.memory),
    all("SELECT kind, subject, content, created_at, updated_at FROM plans ORDER BY updated_at DESC"),
    runtime.briefs.list({ limit: 1000 }).catch(() => []),
    runtime.activity.list({ limit: 200 }),
  ]);
  const data = {
    exportedAt: now.toISOString(),
    note: "Memory, plans, briefs and recent activity. Synced items are copies of your sources and are not included.",
    memory: memory.map((view) => ({ target: view.target, title: view.title, entries: view.entries, updatedAt: view.updatedAt })),
    plans,
    briefs,
    activity,
  };
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="unicorn-export-${now.toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
