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
    const when = schedule.length ? schedule.map((part) => escapeHtml(part.replace(/^routine /, ""))).join("<br>") : '<span class="muted">When you ask</span>';
    return `<li class="pb">
      <div class="pb-name"><h2>${escapeHtml(playbook.title)}</h2><p>Produces ${escapeHtml(playbook.output)}</p></div>
      <div class="pb-main">
        <p class="pb-does">${escapeHtml(copy.does)}</p>
        <p class="pb-ask"><span class="pb-quote">“${escapeHtml(copy.ask)}”</span><button type="button" class="ghost sm" data-copy="${escapeHtml(copy.ask)}" aria-label="Copy the line">${icon("copy")}<span>Copy</span></button></p>
        <p class="pb-foot">Prompt <code>${escapeHtml(playbook.id)}</code>${playbook.arguments.length ? ` · takes ${playbook.arguments.map((arg) => `${escapeHtml(arg.name)}${arg.required ? "" : "?"}`).join(", ")}` : ""}${last ? ` · last brief ${escapeHtml(relative(last.last, now))}, ${last.n} filed` : ""}</p>
      </div>
      <div class="pb-when">${when}</div>
    </li>`;
  }).join("");
  const body = `
    <section class="card"><ul class="pb-list">
      <li class="pb head"><span>Playbook</span><span>What it does · what to say</span><span class="pb-when">Runs</span></li>
      ${cards}
    </ul></section>
    <style>
      .pb-list{list-style:none;margin:0;padding:4px 20px 6px}
      .pb{display:grid;grid-template-columns:minmax(0,15rem) minmax(0,1fr) 11rem;gap:8px 32px;padding:18px 0;border-top:1px solid var(--rule-2)}
      .pb.head{padding:12px 0 10px;border-top:0;font-size:12.5px;color:var(--ink-3);font-weight:500}
      .pb.head .pb-when{color:inherit;font-size:inherit}
      .pb-name p{margin:3px 0 0;font-size:13px;color:var(--ink-3)}
      .pb-does{margin:0;font-size:14.5px;color:var(--ink);max-width:62ch}
      .pb-ask{display:flex;align-items:center;gap:6px;margin:8px 0 0}
      .pb-quote{font-size:14.5px;color:var(--ink-2);font-style:italic}
      .pb-ask button{height:26px;padding:0 8px;background:none;border:0;box-shadow:none;color:var(--ink-3)}
      .pb-ask button:hover{color:var(--ink);background:var(--sel)}
      .pb-foot{margin:8px 0 0;font-size:12.5px;color:var(--ink-3)}
      .pb-foot code{font-size:11.5px;padding:0 4px}
      .pb-when{font-size:13px;color:var(--ink-2);text-align:right;line-height:1.7}
      @media (max-width:900px){.pb{grid-template-columns:minmax(0,1fr)}.pb.head{display:none}.pb-when{text-align:left}}
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

// What each secret or binding is for. Required ones break the Worker when missing; optional
// ones are a second way to connect a source, or a feature that is off without them.
const BINDINGS: Array<{ name: string; purpose: string; required: boolean }> = [
  { name: "ADMIN_TOKEN", purpose: "Signs you in to this panel", required: true },
  { name: "MCP_TOKEN", purpose: "Lets your agent through the door", required: true },
  { name: "DB", purpose: "D1 database", required: true },
  { name: "SCHEDULER", purpose: "Runs the hourly sync", required: true },
  { name: "OAUTH_KV", purpose: "Keeps connector sign-ins", required: true },
  { name: "BROWSER", purpose: "Sign in to Moodle from Sources", required: false },
  { name: "PLUGIN_SECRET_GOOGLE_CLIENT_ID", purpose: "Gmail, with its client secret", required: false },
  { name: "ED_API_TOKEN", purpose: "Ed, instead of Sources", required: false },
  { name: "MOODLE_SESSION", purpose: "Moodle, instead of Sources", required: false },
  { name: "PLUGIN_SECRET_CANVAS_TOKEN", purpose: "Canvas, instead of Sources", required: false },
];

export async function renderDeployment(runtime: PanelRuntime): Promise<string | null> {
  const info = runtime.deployment;
  if (!info) return null;
  const now = runtime.now ? runtime.now() : new Date();
  const zone = safeZone(runtime.timezone);
  const csrf = await computeCsrfToken(runtime.adminToken);
  const host = new URL(info.origin).host;

  const missing = BINDINGS.filter((binding) => binding.required && info.bindings[binding.name] === false);
  const problem = !info.database
    ? "The database is not answering"
    : missing.length
      ? `${missing.map((binding) => binding.name).join(", ")} ${missing.length === 1 ? "is" : "are"} missing`
      : !runtime.schedulerRunning
        ? "Hourly sync is stopped"
        : null;
  const start = runtime.schedulerRunning
    ? ""
    : `<form method="post" action="/settings/start-scheduler"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit" class="button sm">Start hourly sync</button></form>`;
  const fact = (label: string, value: string, tone: "ok" | "bad" | "idle" = "ok") =>
    `<div class="fact"><dt>${label}</dt><dd><span class="dot ${tone}" aria-hidden="true"></span>${value}</dd></div>`;
  const health = `
    <section class="card health">
      <div class="health-head">
        <div><h2>${problem ? escapeHtml(problem) : "Everything is running"}</h2><p class="card-sub">Checked at ${escapeHtml(formatIn(now.toISOString(), zone, { hour: "2-digit", minute: "2-digit", hour12: false }))}.</p></div>
        ${start}
      </div>
      <dl class="facts">
        ${fact("Database", info.database ? "Answering" : "Not answering", info.database ? "ok" : "bad")}
        ${fact("Hourly sync", runtime.schedulerRunning ? "Running" : "Stopped", runtime.schedulerRunning ? "ok" : "bad")}
        ${fact("Last sync", runtime.lastCycle.at ? escapeHtml(relative(runtime.lastCycle.at, now)) : "Never", runtime.lastCycle.at ? "ok" : "idle")}
        ${fact("Pulling sources", info.syncEnabled ? "On" : `Off <a href="/settings#maintenance-title">change</a>`, info.syncEnabled ? "ok" : "idle")}
      </dl>
    </section>`;

  const bindingRow = (binding: (typeof BINDINGS)[number]) => {
    const present = info.bindings[binding.name];
    if (present === undefined) return "";
    const state = present ? "Set" : binding.required ? "Missing" : "Not set";
    const tone = present ? "ok" : binding.required ? "bad" : "idle";
    return `<li><span class="grow"><code>${escapeHtml(binding.name)}</code><span class="purpose">${escapeHtml(binding.purpose)}</span></span><span class="bind-state ${tone}"><span class="dot ${tone}" aria-hidden="true"></span>${state}</span></li>`;
  };
  const secrets = `
    <section class="card">
      <div class="card-head"><h2>Secrets and bindings</h2><p class="card-sub">Whether each is set, never its value. Set secrets with <code>wrangler secret put</code>.</p></div>
      <div class="card-body">
        <p class="group">Required</p><ul class="list binds">${BINDINGS.filter((binding) => binding.required).map(bindingRow).join("")}</ul>
        <p class="group">Optional</p><ul class="list binds">${BINDINGS.filter((binding) => !binding.required).map(bindingRow).join("")}</ul>
      </div>
    </section>`;

  const endpoints = [
    ["Panel", "/panel", "ADMIN_TOKEN"],
    ["Door", "/mcp", "OAuth or MCP_TOKEN"],
    ["Admin MCP", "/mcp/admin", "ADMIN_TOKEN"],
    ["Health", "/health", "Public"],
  ]
    .map(([name, path, auth]) => {
      const url = `${info.origin}${path}`;
      return `<li><span class="grow"><strong>${name}</strong><span class="purpose">${auth}</span></span><code class="end-url">${escapeHtml(host)}${path}</code><button type="button" class="end-copy" data-copy="${escapeHtml(url)}" aria-label="Copy the ${name} URL" title="Copy">${icon("copy")}</button></li>`;
    })
    .join("");
  const endpointCard = `
    <section class="card">
      <div class="card-head"><h2>Endpoints</h2></div>
      <div class="card-body"><ul class="list binds ends">${endpoints}</ul></div>
    </section>`;

  const body = `
    ${health}
    <div class="deploy-grid">
      <div class="col">${secrets}</div>
      <div class="col">
      ${endpointCard}
      <section class="card"><div class="card-head"><h2>Upgrade</h2><p class="card-sub">Run from your clone. Data and secrets stay. <a href="https://unicorn.tuuhub.com/docs/unicorn/upgrade" target="_blank" rel="noopener">Notes</a></p></div><div class="card-body">
        ${copyRow("git pull && npm ci && npm run upgrade", true)}
      </div></section>
      <section class="card"><div class="card-head"><h2>Your data</h2><p class="card-sub">Kept in your D1 database. Old items outside your units archive after ${info.retentionDays} days.</p></div><div class="card-body">
        <a class="button ghost data-export" href="/panel/export" download>${icon("download")}<span>Export memory, plans and briefs</span></a>
        <p class="group data-group">Full backup</p>
        ${copyRow("wrangler d1 export unicorn --remote --output backup.sql", true)}
      </div></section>
      </div>
    </div>
    <style>
      .deploy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}
      .deploy-grid .col{display:flex;flex-direction:column;gap:16px;min-width:0}
      .deploy-grid .card{height:auto;margin:0}
      @media (max-width:1000px){.deploy-grid{grid-template-columns:minmax(0,1fr)}}
      .health{height:auto;margin-bottom:16px}
      .health-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 20px 0}
      .health-head h2{margin:0;font-size:18px;line-height:26px;font-weight:600;letter-spacing:-.01em}
      .health-head form{margin:0}
      .facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:16px 0 0;border-top:1px solid var(--separator)}
      .fact{padding:14px 20px 16px;border-left:1px solid var(--separator)}
      .fact:first-child{border-left:0}
      .fact dt{color:var(--muted);font-size:12.5px}
      .fact dd{display:flex;align-items:center;gap:7px;margin:4px 0 0;font-size:15px;font-weight:500;font-variant-numeric:tabular-nums}
      .fact dd a{font-size:12.5px;font-weight:400;color:var(--muted)}
      .dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--fg)}
      .dot.idle{background:transparent;box-shadow:inset 0 0 0 1.5px var(--faint)}
      .dot.bad{background:var(--danger)}
      .group{margin:4px 0 2px;color:var(--muted);font-size:12.5px}
      .group:not(:first-child){margin-top:16px}
      .binds>li{padding:10px 0}
      .binds .grow{display:flex;flex-direction:column;gap:2px}
      .binds code{align-self:flex-start;font-size:12px}
      .binds strong{font-weight:500}
      .purpose{color:var(--muted);font-size:12.5px}
      .bind-state{display:inline-flex;align-items:center;gap:7px;flex:none;font-size:13px}
      .bind-state.idle{color:var(--muted)}
      .bind-state.bad{color:var(--danger-text)}
      /* Endpoints share one grid so every URL starts on the same line; the copy glyph, not
         its hit area, sits on the card's right edge. */
      .ends{display:grid;grid-template-columns:minmax(0,1fr) max-content max-content;column-gap:16px}
      .ends>li{display:grid;grid-column:1/-1;grid-template-columns:subgrid;align-items:center}
      .ends code.end-url{align-self:center;background:none;padding:0;font-size:12.5px;color:var(--muted)}
      .end-copy{display:grid;place-items:center;width:32px;height:32px;margin:-4px -8px -4px -8px;padding:0;border:0;border-radius:10px;background:none;color:var(--muted);cursor:pointer}
      .end-copy:hover{background:var(--default);color:var(--fg)}
      .end-copy .i{width:16px;height:16px}
      .binds code{background:none;padding:0}
      .data-export{align-self:flex-start}
      .group.data-group{margin:4px 0 -4px}
      .card-body .cmd{margin:0}
      .card-body{gap:12px}
      @media (max-width:760px){
        .facts{grid-template-columns:repeat(2,minmax(0,1fr))}
        .fact:nth-child(3){border-left:0}
        .fact:nth-child(n+3){border-top:1px solid var(--separator)}
        .health-head{flex-wrap:wrap}
      }
      @media (max-width:640px){
        .ends{grid-template-columns:minmax(0,1fr) max-content}
        .ends .grow{grid-column:1/-1}
        .ends code.end-url{overflow-wrap:anywhere}
      }
    </style>
    ${PANEL_STYLE}${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — deployment",
    active: "/panel/deployment",
    heading: "Deployment",
    subtitle: `${escapeHtml(host)}, on your own Cloudflare account.`,
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
