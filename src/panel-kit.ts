// Shared pieces for the panel's pages (ADR-0048): formatting in the user's timezone, empty
// states, copy rows, and the page-level styles and script every panel page appends.

import { clientLogo, icon } from "./marks";
import { escapeHtml } from "./ui";

export const SOURCE_NAMES: Record<string, string> = {
  "campus-moodle": "Moodle",
  "campus-ed": "Ed",
  "campus-canvas": "Canvas",
  gmail: "Gmail",
};

export function copyRow(value: string, shell = false, hero = false): string {
  return `<div class="cmd${hero ? " hero" : ""}"><code>${shell ? '<span class="prompt">$ </span>' : ""}${escapeHtml(value)}</code><button type="button" data-copy="${escapeHtml(value)}" aria-label="Copy">${icon("copy")}<span>Copy</span></button></div>`;
}

// --- shared bits --------------------------------------------------------------

// A line to say to the user's agent. unicorn has no brain of its own, so the chip hands the
// line over: opened as a new chat in Claude or ChatGPT (both prefill from ?q=, and the user
// still presses send), or copied for any other client.
export function askChip(line: string): string {
  const q = encodeURIComponent(line);
  return `<details class="ask"><summary>${icon("spark")}<span>${escapeHtml(line)}</span></summary><div class="ask-menu">
      <a class="plain" href="https://claude.ai/new?q=${q}" target="_blank" rel="noopener">${clientLogo("claude")}<span>Open in Claude</span></a>
      <a class="plain" href="https://chatgpt.com/?q=${q}" target="_blank" rel="noopener">${clientLogo("chatgpt")}<span>Open in ChatGPT</span></a>
      <button type="button" data-copy="${escapeHtml(line)}">${icon("copy")}<span>Copy</span></button>
    </div></details>`;
}

export function emptyAsk(iconName: Parameters<typeof icon>[0], text: string, line: string): string {
  return `<div class="empty">${icon(iconName)}<p>${text}</p>${askChip(line)}</div>`;
}

export function empty(iconName: Parameters<typeof icon>[0], text: string): string {
  return `<div class="empty">${icon(iconName)}<p>${text}</p></div>`;
}

// The memory specs' purposes are written for the agent ("the user …"); these are for the person.
export const MEMORY_PURPOSE: Record<string, string> = {
  user: "Who you are: university, degree, year, goals, how you like to work.",
  notes: "Follow-ups, decisions and per-unit conventions your agents track.",
  corrections: "Rules you stated, kept word for word.",
  term: "This term's units, rebuilt from your sources each sync.",
};

export function memoryTitle(value: string): string {
  const known: Record<string, string> = { "USER PROFILE": "User profile", NOTES: "Notes", TERM: "Term", user: "User profile", notes: "Notes", corrections: "Corrections", term: "Term" };
  return known[value] ?? capitalize(value.toLowerCase());
}

export function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export function timeTag(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(iso.slice(0, 16).replace("T", " "))} UTC</time>`;
}

// Submission states that mean "handed in": a past deadline in one of these is not overdue.
const DONE_STATES = new Set(["submitted", "graded", "complete", "completed", "done", "pending_review"]);
export function isHandedIn(state: string | null): boolean {
  return state !== null && DONE_STATES.has(state.toLowerCase());
}

export function safeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

export function formatIn(iso: string, zone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-AU", { ...options, timeZone: zone }).format(new Date(iso));
}

export function dayKey(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone }).format(new Date(iso));
}

export function longDate(now: Date, zone: string): string {
  return formatIn(now.toISOString(), zone, { weekday: "long", day: "numeric", month: "long" });
}

/** "12m", "3h", "2d": for stat values and table cells where a sentence won't fit. */
export function shortAgo(iso: string, now: Date): string {
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
export const PANEL_STYLE = `<style>
.ask{position:relative;min-width:0;max-width:100%}
.ask>summary{display:flex;align-items:center;gap:7px;max-width:100%;height:32px;padding:0 13px 0 11px;border-radius:999px;background:var(--surface);box-shadow:var(--shadow);color:var(--fg);font-size:13px}
.ask>summary::before{content:none}
.ask>summary .i{flex:none;width:14px;height:14px;color:var(--muted)}
.ask>summary:hover,.ask[open]>summary{background:var(--default)}
.ask-menu{position:absolute;z-index:20;top:calc(100% + 6px);left:0;transform-origin:top left;display:flex;flex-direction:column;min-width:200px;padding:4px;border-radius:12px;background:var(--surface);box-shadow:var(--shadow-lg)}
.ask-menu a,.ask-menu button{display:flex;align-items:center;justify-content:flex-start;gap:10px;width:100%;box-shadow:none;height:34px;padding:0 10px;border:0;border-radius:8px;background:none;color:var(--fg);font:inherit;font-size:13px;text-align:left;text-decoration:none;cursor:pointer}
.ask-menu a:hover,.ask-menu button:hover{background:var(--default)}
.ask-menu .i{flex:none;width:16px;height:16px;color:var(--muted)}
.empty .ask{margin-top:4px}
.empty .ask-menu{left:50%;translate:-50% 0}
details.ask[open]>.ask-menu{animation:menu-in .16s var(--ease-out)}
.empty .ask-menu{transform-origin:top center}
@keyframes menu-in{from{opacity:0;transform:scale(.97) translateY(-2px)}}
.setup .card-head{align-items:center}
.setup .progress{width:160px;flex:none}
.setup-steps{list-style:none;margin:0;padding:12px 16px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px}
.setup-steps li{display:flex;gap:12px;padding:14px;border-radius:12px;background:var(--surface-2)}
.setup-steps h3{font-size:14px;font-weight:600}
.setup-steps p{margin:2px 0 10px;color:var(--muted);font-size:13px}
.setup-steps li.done{background:transparent;box-shadow:inset 0 0 0 1px var(--separator)}
.setup-steps li.done p{margin-bottom:0}
.setup-steps li.done h3{color:var(--muted)}
@media (max-width:640px){.setup-steps li.done{display:none}}
.setup-num{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:999px;background:var(--surface);box-shadow:var(--shadow);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--muted)}
.setup-num .i{width:14px;height:14px}
.done .setup-num{background:var(--success-soft);color:var(--success-text);box-shadow:none}
.setup-steps .more{padding:0 10px 0 0;height:24px}
.setup-steps .more:hover{background:none;color:var(--fg)}
.agenda{display:flex;flex-direction:column}
.day{display:grid;grid-template-columns:56px minmax(0,1fr);gap:12px;padding:12px 0;border-top:1px solid var(--separator)}
.day:first-child{border-top:0;padding-top:0}
.day-label{display:flex;flex-direction:column;align-items:center;justify-content:center;align-self:start;width:48px;height:52px;border-radius:12px;background:var(--surface-2);line-height:1.1}
.dow{font-size:11px;font-weight:500;color:var(--muted)}
.dom{font-size:18px;font-weight:600;letter-spacing:-.02em}
.mon{display:none}
.day.today .day-label{background:var(--fg);color:var(--bg)}
.day.today .dow,.day.today .dom,.day.today .mon{color:var(--bg)}
.day .list>li{padding:8px 0}
.day .list>li:first-child{padding-top:6px}
.due-row,.term-row{display:flex;align-items:center;gap:10px;min-width:0}
.due-row a:hover{text-decoration:underline;text-underline-offset:3px}
.src-list{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.src-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:999px;background:var(--surface-2);font-size:12px;font-weight:500;color:var(--fg-2)}
.src-chip .src-dot{width:6px;height:6px}
.legend{display:inline-flex;gap:14px;font-size:12px;color:var(--muted)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%}
.dot.accent{background:var(--accent)}
.dot.danger{background:var(--danger)}
.chart-stats{display:flex;gap:32px;margin:0 0 16px}
.chart-stats div{display:flex;flex-wrap:wrap;align-items:center;column-gap:8px}
.chart-stats strong{font-size:20px;font-weight:600;letter-spacing:-.4px}
.chart-stats span:last-child{flex-basis:100%;font-size:12px;color:var(--muted)}
.chart{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;flex:1;min-height:180px}
.chart-y{display:flex;flex-direction:column;justify-content:space-between;font-size:11px;color:var(--muted);text-align:right;padding-bottom:22px;margin-top:-6px}
.chart-y span{line-height:12px}
.chart-plot{position:relative;min-width:0}
.chart-grid{position:absolute;inset:0 0 22px 0;display:flex;flex-direction:column;justify-content:space-between}
.chart-grid i{display:block;height:1px;background:var(--separator)}
.chart-bars{position:absolute;inset:0;display:grid;grid-template-columns:repeat(7,1fr)}
.bar-col{display:flex;flex-direction:column;align-items:center;min-width:0}
.bar-stack{flex:1;width:min(22px,60%);display:flex;flex-direction:column;justify-content:flex-end;margin-bottom:6px}
.bar-ok{display:block;width:100%;min-height:0;background:color-mix(in oklab,var(--fg) 26%,transparent);transition:background-color .15s ease}
.bar-ok:first-child,.bar-err{border-radius:5px 5px 0 0}
.bar-err{display:block;width:100%;background:var(--danger)}
.bar-col.today .bar-ok,.bar-col:hover .bar-ok{background:var(--fg)}
.bar-label{height:16px;font-size:11px;color:var(--muted)}
.bar-col.today .bar-label{color:var(--fg);font-weight:600}
.clients>li{padding:10px 0}
.client-row{display:flex;align-items:center;gap:12px}
.client-info{display:flex;flex-direction:column;flex:1;min-width:0;gap:4px}
.client-top{display:flex;justify-content:space-between;gap:8px;font-size:14px}
.client-top strong{font-weight:600}
.client-sub{font-size:12px;color:var(--muted)}
.bar{display:block;height:4px;border-radius:999px;background:var(--default);overflow:hidden}
.bar>span{display:block;height:100%;background:var(--accent);border-radius:999px}
.tools .grow{display:flex;flex-direction:column;gap:6px}
.act-week{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px;margin:16px 0}
.act-week .card{height:auto;margin:0}
@media (max-width:900px){.act-week{grid-template-columns:minmax(0,1fr)}}
.ranks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.ranks li{position:relative;isolation:isolate;display:flex;align-items:center;gap:12px;height:34px;padding:0 10px;font-size:13px}
.ranks li::before{content:"";position:absolute;inset:0;z-index:-1;width:var(--fill);border-radius:8px;background:color-mix(in oklab,var(--fg) 8%,transparent);transform-origin:left;animation:rank-in .5s var(--ease-out) calc(var(--i) * 40ms) both}
.rank-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.rank-calls{font-weight:500}
.rank-share{width:4ch;text-align:right;color:var(--muted);font-size:12px}
@keyframes rank-in{from{transform:scaleX(0)}}
.bar-ok,.bar-err{transform-origin:bottom;animation:bar-in .5s var(--ease-out) both}
.bar-col:nth-child(2) span{animation-delay:30ms}.bar-col:nth-child(3) span{animation-delay:60ms}.bar-col:nth-child(4) span{animation-delay:90ms}
.bar-col:nth-child(5) span{animation-delay:120ms}.bar-col:nth-child(6) span{animation-delay:150ms}.bar-col:nth-child(7) span{animation-delay:180ms}
@keyframes bar-in{from{transform:scaleY(0)}}
.profile>li{font-size:14px}
.brief-line{display:flex;align-items:center;gap:10px;min-width:0}
.brief-line:hover .truncate{text-decoration:underline;text-underline-offset:3px}
.truncate-cell{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed-row{display:flex;align-items:center;gap:10px;min-width:0}
.feed-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
.feed-text strong{font-weight:600}
.client-stack{gap:0}
.client-stack .tile-mark{margin-right:-6px;box-shadow:0 0 0 2px var(--surface)}
.mem-meta{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:12px;margin-bottom:6px;white-space:nowrap}
.wide-cards{grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))}
.mem-actions{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:12px}
.address .card-body{padding-top:8px}
.works{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px}
.works-row{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.client-card{display:flex;flex-direction:column}
.client-head{display:flex;align-items:center;gap:14px}
.tile-cluster{display:inline-flex;flex:none}
.tile-cluster .tile-mark{margin-right:-10px;box-shadow:0 0 0 2px var(--surface)}
.tile-cluster .tile-mark:last-child{margin-right:0}
.apps .grow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.since{white-space:nowrap}
@media (max-width:640px){.chart-stats{gap:20px}.truncate-cell{max-width:160px}}
</style>`;

export const PANEL_SCRIPT = `
<script>
(function () {
  document.querySelectorAll("time[datetime]").forEach(function (node) {
    try { node.textContent = new Date(node.getAttribute("datetime")).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (_) {}
  });
  document.addEventListener("click", function (event) {
    document.querySelectorAll("details.ask[open]").forEach(function (menu) {
      var item = event.target.closest && event.target.closest(".ask-menu a");
      if (!menu.contains(event.target) || (item && menu.contains(item))) menu.removeAttribute("open");
    });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") document.querySelectorAll("details.ask[open]").forEach(function (menu) { menu.removeAttribute("open"); });
  });
  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var value = button.getAttribute("data-copy") || "";
      var label = button.querySelector("span");
      var original = button.innerHTML;
      navigator.clipboard.writeText(value).then(function () {
        if (label) label.textContent = "Copied"; else button.innerHTML = '${icon("check")}';
        setTimeout(function () { button.innerHTML = original; }, 1500);
      });
    });
  });
})();
</script>`;
