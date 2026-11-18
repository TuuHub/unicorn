// /panel/memory: what every agent session reads first (ADR-0047), shown as entries the user can
// edit one at a time, beside a feed of who changed what with an Undo on each change.

import type { ActivityEntry } from "./activity";
import {
  entryDate,
  MEMORY_TARGETS,
  MemoryOperationError,
  type MemoryOperation,
  type MemoryTarget,
  type MemoryView,
  readAllMemory,
  staleEntries,
  trackMemoryWrite,
  undoOperations,
  writeMemory,
} from "./agent-memory";
import { clientMark, clientTile, icon } from "./marks";
import { MemoryConflictError } from "./memory";
import type { PanelRuntime } from "./panel";
import { emptyAsk, MEMORY_PURPOSE, memoryTitle, PANEL_SCRIPT, PANEL_STYLE, shortAgo } from "./panel-kit";
import { computeCsrfToken } from "./settings";
import { escapeHtml, renderPage } from "./ui";

const WRITABLE = new Set<string>(["user", "notes", "corrections"]);
const CORRECTION_PREFIX = /^- \[\d{4}-\d{2}-\d{2}\] /;
const DONE: Record<string, string> = { added: "Added.", edited: "Saved.", removed: "Deleted.", undone: "Undone." };
const EMPTY_ASK: Partial<Record<MemoryTarget, [string, string]>> = {
  user: ["Nothing yet. Your agent writes this as it gets to know you.", "Get to know me."],
  notes: ["No follow-ups or decisions yet.", "What should you keep track of for me this week?"],
  corrections: ["No rules yet. Tell your agent when it gets something wrong.", "Remember that I never want reminders on Sundays."],
};

export async function renderMemoryPage(runtime: PanelRuntime, url: URL): Promise<string> {
  const now = runtime.now ? runtime.now() : new Date();
  const [views, changes, csrf] = await Promise.all([
    readAllMemory(runtime.memory),
    runtime.activity.list({ kind: "memory", limit: 60 }),
    computeCsrfToken(runtime.adminToken),
  ]);
  const done = DONE[url.searchParams.get("saved") ?? ""];
  const error = url.searchParams.get("error");
  const errorTarget = url.searchParams.get("target");
  // Stores the user can edit first; the read-only term list last.
  const ordered = [...views].sort((a, b) => Number(!WRITABLE.has(a.target)) - Number(!WRITABLE.has(b.target)));
  const cards = ordered.map((view) => renderStore(view, csrf, now, errorTarget === view.target ? error : null)).join("");
  const body = `
    ${done ? `<p class="notice" role="status">${done}</p>` : ""}
    ${error && !errorTarget ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ""}
    <div class="mem-layout">
      <div class="mem-stores">${cards}</div>
      ${renderChanges(changes, csrf, now)}
    </div>
    ${PANEL_STYLE}
    ${MEMORY_STYLE}
    ${PANEL_SCRIPT}
    ${MEMORY_SCRIPT}`;
  return renderPage({
    title: "unicorn — memory",
    active: "/panel/memory",
    heading: "Memory",
    subtitle: "Every agent reads this before it answers, and keeps it current. Review and fix it here.",
    body,
    wide: true,
  });
}

function renderStore(view: MemoryView, csrf: string, now: Date, error: string | null): string {
  const writable = WRITABLE.has(view.target);
  const stale = new Set(staleEntries(view, now));
  const updated = view.updatedAt ? `<span class="mem-updated" title="${escapeHtml(view.updatedAt)}">${escapeHtml(shortAgo(view.updatedAt, now))}</span>` : "";
  const entries = view.entries.length
    ? `<ul class="mem-list">${view.entries.map((entry) => (writable ? editableEntry(view.target, entry, csrf, stale.has(entry)) : `<li class="mem-entry"><span class="mem-row"><span class="mem-text">${escapeHtml(entry)}</span></span></li>`)).join("")}</ul>`
    : writable && EMPTY_ASK[view.target]
      ? emptyAsk("memory", EMPTY_ASK[view.target]![0], EMPTY_ASK[view.target]![1])
      : `<p class="muted mem-none">Filled after the first sync.</p>`;
  const add = writable
    ? `<form method="post" action="/panel/memory/${view.target}" class="mem-add">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="op" value="add">
        <input type="text" name="content" required maxlength="1000" autocomplete="off" aria-label="New ${escapeHtml(memoryTitle(view.target).toLowerCase())} entry" placeholder="${view.target === "corrections" ? "Add a rule" : "Add an entry"}">
        <button type="submit" class="secondary sm">Add</button>
      </form>`
    : view.entries.length
      ? `<p class="muted small mem-foot">Wrong? Tell your agent. It records the fix in Notes.</p>`
      : "";
  const alert = error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : "";
  return `<section class="card mem-card" id="mem-${view.target}">
    <div class="card-head row"><div><h2>${escapeHtml(memoryTitle(view.title))}</h2><p class="card-sub">${escapeHtml(MEMORY_PURPOSE[view.target] ?? view.purpose)}</p></div>${updated}</div>
    <div class="card-body">${alert}${entries}${add}</div>
  </section>`;
}

function editableEntry(target: MemoryTarget, entry: string, csrf: string, stale: boolean): string {
  const prefix = target === "corrections" ? entry.match(CORRECTION_PREFIX)?.[0] ?? "" : "";
  const text = entry.slice(prefix.length);
  const date = prefix ? entryDate(entry) : null;
  const meta = stale
    ? `<span class="mem-meta" title="Dated more than three weeks ago. Still true?">${icon("clock")}Old</span>`
    : date
      ? `<span class="mem-meta">${escapeHtml(dayMonth(date))}</span>`
      : "";
  const rows = Math.min(8, Math.max(2, Math.ceil(text.length / 70) + (text.match(/\n/g)?.length ?? 0)));
  return `<li class="mem-entry"><details>
    <summary class="mem-row"><span class="mem-text">${escapeHtml(text)}</span>${meta}<span class="mem-pen" aria-hidden="true">${icon("edit")}</span></summary>
    <form method="post" action="/panel/memory/${target}" class="mem-edit">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="old" value="${escapeHtml(entry)}">
      <textarea name="content" rows="${rows}" maxlength="1000" aria-label="Edit entry">${escapeHtml(text)}</textarea>
      <div class="mem-edit-bar">
        <button type="submit" name="op" value="remove" class="ghost sm mem-delete">Delete</button>
        <span class="grow"></span>
        <button type="button" class="ghost sm" data-mem-cancel>Cancel</button>
        <button type="submit" name="op" value="edit" class="sm">Save</button>
      </div>
    </form>
  </details></li>`;
}

function renderChanges(changes: ActivityEntry[], csrf: string, now: Date): string {
  const relevant = changes.filter((change) => MEMORY_TARGETS[change.name as MemoryTarget] && (lines(change.detail.added).length || lines(change.detail.removed).length));
  const undone = new Set(relevant.map((change) => change.detail.undo).filter((id): id is number => typeof id === "number"));
  const items = relevant.slice(0, 30).map((change) => renderChange(change, csrf, now, undone.has(change.id))).join("");
  const body = items ? `<ol class="mem-feed">${items}</ol>` : `<p class="muted mem-none">When an agent adds, edits or removes an entry, it shows up here.</p>`;
  return `<aside class="card mem-changes" aria-label="Recent memory changes">
    <div class="card-head"><h2>Changes</h2><p class="card-sub">Who changed what. Undo puts it back.</p></div>
    <div class="card-body">${body}</div>
  </aside>`;
}

function renderChange(change: ActivityEntry, csrf: string, now: Date, undone: boolean): string {
  const added = lines(change.detail.added);
  const removed = lines(change.detail.removed);
  const actor = change.actor ?? change.via;
  const mark = clientMark(actor);
  const name = mark.id === "unicorn" ? "You" : mark.id === "scheduler" ? "unicorn" : mark.id === "other" || mark.id === "token" || !actor ? mark.name : actor;
  const store = memoryTitle(change.name);
  const verb = typeof change.detail.undo === "number" ? `undid a change to ${store}` : added.length && removed.length ? `edited ${store}` : added.length ? `added to ${store}` : `removed from ${store}`;
  const strip = (entry: string) => entry.replace(CORRECTION_PREFIX, "");
  const diff = [
    ...removed.map((entry) => `<li class="del"><span class="sign" aria-label="removed">−</span><span>${escapeHtml(strip(entry))}</span></li>`),
    ...added.map((entry) => `<li class="add"><span class="sign" aria-label="added">+</span><span>${escapeHtml(strip(entry))}</span></li>`),
  ].join("");
  const undo =
    WRITABLE.has(change.name) && !undone
      ? `<form method="post" action="/panel/memory/undo" class="mem-undo"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="id" value="${change.id}"><button type="submit" class="ghost sm">Undo</button></form>`
      : undone
        ? `<span class="muted small mem-undone">Undone</span>`
        : "";
  return `<li class="mem-change">
    <div class="mem-change-head">${clientTile(actor, "sm")}<p><strong>${escapeHtml(name)}</strong> <span class="muted">${escapeHtml(verb)}</span></p><span class="muted small tabular" title="${escapeHtml(change.at)}">${escapeHtml(shortAgo(change.at, now))}</span></div>
    <ul class="mem-diff">${diff}</ul>
    ${undo}
  </li>`;
}

/** POST /panel/memory/:target — add, edit or remove one entry. */
export async function saveMemoryEntry(runtime: PanelRuntime, target: MemoryTarget, form: FormData, url: URL): Promise<Response> {
  const op = String(form.get("op") ?? "");
  const old = String(form.get("old") ?? "");
  let content = String(form.get("content") ?? "").replace(/\r\n/g, "\n").trim();
  let operations: MemoryOperation[];
  let done: string;
  if (op === "add") {
    operations = [{ action: "add", content }];
    done = "added";
  } else if (op === "remove" || (op === "edit" && !content)) {
    operations = [{ action: "remove", old_text: old }];
    done = "removed";
  } else if (op === "edit") {
    // The textarea shows a correction without its date; keep the date it was stated on.
    const prefix = target === "corrections" ? old.match(CORRECTION_PREFIX)?.[0] : undefined;
    if (prefix && !CORRECTION_PREFIX.test(content)) content = `${prefix}${content}`;
    if (content === old) return back(url, "", target);
    operations = [{ action: "patch", old_text: old, content }];
    done = "edited";
  } else {
    return new Response("Unknown memory action.", { status: 400 });
  }
  return applyFromPanel(runtime, target, operations, done, url);
}

/** POST /panel/memory/undo — replays the inverse of one logged change. */
export async function undoMemoryChange(runtime: PanelRuntime, form: FormData, url: URL): Promise<Response> {
  const id = Number(form.get("id"));
  const [change] = Number.isInteger(id) ? await runtime.activity.list({ kind: "memory", before: id + 1, limit: 1 }) : [];
  if (!change || change.id !== id || !WRITABLE.has(change.name)) {
    return back(url, `error=${encodeURIComponent("That change is no longer in the log.")}`);
  }
  const target = change.name as MemoryTarget;
  const operations = undoOperations({ added: lines(change.detail.added), removed: lines(change.detail.removed) });
  return applyFromPanel(runtime, target, operations, "undone", url, { undo: id });
}

async function applyFromPanel(runtime: PanelRuntime, target: MemoryTarget, operations: MemoryOperation[], done: string, url: URL, extra: Record<string, unknown> = {}): Promise<Response> {
  const now = runtime.now ? runtime.now() : new Date();
  try {
    await trackMemoryWrite(runtime.memory, runtime.activity, target, { actor: null, via: "panel" }, () => writeMemory(runtime.memory, target, operations, { now }), extra);
    return back(url, `saved=${done}`, target);
  } catch (error) {
    const message =
      error instanceof MemoryOperationError
        ? error.code === "not_found" || error.code === "ambiguous"
          ? "That entry changed since the page loaded, probably by an agent. Nothing was saved. Reload and try again."
          : error.code === "duplicate"
            ? "That's already in memory."
            : error.message
        : error instanceof MemoryConflictError
          ? "An agent saved at the same moment. Nothing was saved. Try again."
          : "Memory could not be saved.";
    return back(url, `error=${encodeURIComponent(message)}&target=${target}`, target);
  }
}

function back(url: URL, query: string, target?: MemoryTarget): Response {
  const anchor = target ? `#mem-${target}` : "";
  return new Response(null, { status: 303, headers: { location: new URL(`/panel/memory?${query}${anchor}`, url).toString() } });
}

function lines(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function dayMonth(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
}

const MEMORY_SCRIPT = `
<script>
(function () {
  document.querySelectorAll(".mem-entry details").forEach(function (entry) {
    entry.addEventListener("toggle", function () {
      if (!entry.open) return;
      document.querySelectorAll(".mem-entry details[open]").forEach(function (other) { if (other !== entry) other.removeAttribute("open"); });
      var box = entry.querySelector("textarea");
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    });
  });
  document.querySelectorAll("[data-mem-cancel]").forEach(function (button) {
    button.addEventListener("click", function () {
      var entry = button.closest("details");
      var box = entry.querySelector("textarea");
      box.value = box.defaultValue;
      entry.removeAttribute("open");
    });
  });
  document.addEventListener("keydown", function (event) {
    var box = event.target;
    if (!box.matches || !box.matches(".mem-edit textarea")) return;
    if (event.key === "Escape") { box.value = box.defaultValue; box.closest("details").removeAttribute("open"); }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); box.form.querySelector('[value="edit"]').click(); }
  });
})();
</script>`;

const MEMORY_STYLE = `<style>
.mem-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,360px);gap:24px;align-items:start}
.mem-stores{display:grid;gap:24px;min-width:0}
.mem-changes{position:sticky;top:24px;max-height:calc(100vh - 48px);display:flex;flex-direction:column}
.mem-changes .card-body{overflow:auto;min-height:0}
@media (max-width:1100px){.mem-layout{grid-template-columns:1fr}.mem-changes{position:static;max-height:none}}
.mem-updated{color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.mem-card .card-body>.notice.error{margin:0 0 12px}
.mem-list{list-style:none;margin:0 -12px;padding:0}
.mem-entry+.mem-entry{border-top:1px solid var(--separator)}
.mem-entry summary.mem-row{max-width:none;color:var(--fg);font-size:14px;gap:12px;align-items:flex-start}
.mem-entry summary.mem-row::before{content:none}
.mem-row{display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border-radius:12px}
summary.mem-row{cursor:pointer;transition:background-color .15s ease}
summary.mem-row:hover{background:var(--surface-2)}
.mem-text{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:21px}
.mem-meta{display:inline-flex;align-items:center;gap:4px;color:var(--muted);font-size:12.5px;line-height:21px;white-space:nowrap;font-variant-numeric:tabular-nums}
.mem-meta .i{width:13px;height:13px}
.mem-pen{display:inline-grid;place-items:center;width:21px;height:21px;color:var(--faint);opacity:0;transition:opacity .15s ease}
.mem-pen .i{width:15px;height:15px}
summary.mem-row:hover .mem-pen,summary.mem-row:focus-visible .mem-pen{opacity:1}
@media (hover:none){.mem-pen{opacity:1}}
.mem-entry details[open]>summary{display:none}
.mem-edit{padding:4px 0 10px}
.mem-edit textarea{width:100%;min-height:0;resize:vertical;font:inherit;line-height:21px}
.mem-edit-bar{display:flex;align-items:center;gap:8px;margin-top:8px}
.mem-edit-bar .grow{flex:1}
.mem-delete{color:var(--danger-text)}
.mem-delete:hover{background:var(--danger-soft)}
.mem-add{display:flex;gap:8px;margin-top:12px}
.mem-list+.mem-add{padding-top:12px;border-top:1px solid var(--separator)}
.mem-add input{flex:1;min-width:0;height:32px}
.mem-none{margin:0}
.mem-foot{margin:12px 0 0}
.mem-feed{list-style:none;margin:0;padding:0}
.mem-change{display:grid;gap:8px;padding:14px 0}
.mem-change:first-child{padding-top:0}
.mem-change+.mem-change{border-top:1px solid var(--separator)}
.mem-change-head{display:flex;align-items:center;gap:10px}
.mem-change-head p{flex:1;min-width:0;margin:0;font-size:13.5px;line-height:20px}
.mem-diff{list-style:none;margin:0;padding:0 0 0 34px;display:grid;gap:4px;font-size:13.5px;line-height:20px}
.mem-diff li{display:flex;gap:8px;min-width:0}
.mem-diff li>span:last-child{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.mem-diff .sign{flex:none;width:10px;color:var(--faint);font-variant-numeric:tabular-nums}
.mem-diff .del>span:last-child{color:var(--muted);text-decoration:line-through;text-decoration-color:var(--faint)}
.mem-undo,.mem-undone{margin:0 0 0 34px}
.mem-undo button{margin-left:-10px;height:28px;padding:0 10px;background:none;color:var(--muted);font-size:13px}
.mem-undo button:hover{background:var(--default);color:var(--fg)}
</style>`;
