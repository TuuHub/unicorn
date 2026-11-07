// Shared pieces for the panel's pages (ADR-0048): formatting in the user's timezone, empty
// states, copy rows, and the page-level styles and script every panel page appends.

import { icon } from "./marks";
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
.due-row,.term-row{display:flex;align-items:center;gap:8px;min-width:0}
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

export const PANEL_SCRIPT = `
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
