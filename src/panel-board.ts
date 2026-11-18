// The overview board: which widgets the overview shows, in what order, at what width.
//
// The layout is one JSON row in `settings` (key "overview_board"). The server renders it; the
// edit mode below only reorders, resizes and hides the widgets already on the page and posts the
// result back as a plain form (the panel's CSP allows no fetch). Every widget is always rendered,
// hidden ones with the `hidden` attribute, so "Add" needs no round trip.

import { icon } from "./marks";
import { escapeHtml } from "./ui";

export type WidgetSize = "s" | "m" | "l";
export interface BoardSlot {
  id: WidgetId;
  size: WidgetSize;
}

export const WIDGETS = {
  due: "Due soon",
  changes: "What changed",
  units: "Units",
  briefs: "From your agents",
  plan: "This week's plan",
  grades: "Grades",
  agents: "Agent activity",
  profile: "Your profile",
  calls: "Recent calls",
} as const;
export type WidgetId = keyof typeof WIDGETS;

export const DEFAULT_BOARD: BoardSlot[] = [
  { id: "due", size: "m" },
  { id: "changes", size: "s" },
  { id: "units", size: "m" },
  { id: "briefs", size: "s" },
  { id: "plan", size: "s" },
  { id: "grades", size: "s" },
  { id: "agents", size: "s" },
];

const SIZES: WidgetSize[] = ["s", "m", "l"];
const SIZE_LABELS: Record<WidgetSize, string> = { s: "Small", m: "Medium", l: "Full width" };

/** Keeps known widgets with a valid size, once each, in order. Anything else falls back to the default. */
export function parseBoard(value: unknown): BoardSlot[] {
  if (!Array.isArray(value)) return DEFAULT_BOARD;
  const seen = new Set<string>();
  const slots: BoardSlot[] = [];
  for (const entry of value) {
    const id = (entry as { id?: unknown })?.id;
    const size = (entry as { size?: unknown })?.size;
    if (typeof id !== "string" || !(id in WIDGETS) || seen.has(id)) continue;
    seen.add(id);
    slots.push({ id: id as WidgetId, size: SIZES.includes(size as WidgetSize) ? (size as WidgetSize) : "s" });
  }
  return slots;
}

export async function loadBoard(db: D1Database): Promise<BoardSlot[]> {
  try {
    const row = await db.prepare("SELECT value_json FROM settings WHERE key = 'overview_board'").first<{ value_json: string }>();
    return row ? parseBoard(JSON.parse(row.value_json)) : DEFAULT_BOARD;
  } catch {
    return DEFAULT_BOARD;
  }
}

export async function saveBoard(db: D1Database, slots: BoardSlot[] | null): Promise<void> {
  if (slots === null) {
    await db.prepare("DELETE FROM settings WHERE key = 'overview_board'").run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('overview_board', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(slots), new Date().toISOString())
    .run();
}

/** POST /panel/board: `reset=1` restores the default, otherwise `layout` is the edited board. */
export async function handleBoardPost(db: D1Database, form: FormData, url: URL): Promise<Response> {
  if (form.get("reset")) {
    await saveBoard(db, null);
  } else {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(String(form.get("layout") ?? ""));
    } catch {
      return new Response("Invalid layout.", { status: 400 });
    }
    await saveBoard(db, parseBoard(parsed));
  }
  return new Response(null, { status: 303, headers: { location: new URL("/panel", url).toString() } });
}

export interface WidgetContent {
  title: string;
  more?: { href: string; label: string };
  count?: number;
  body: string;
}

/** The board: every widget, visible ones in layout order first, then the hidden ones. */
export function renderBoard(slots: BoardSlot[], content: Record<WidgetId, WidgetContent>, csrf: string): string {
  const visible = new Set(slots.map((slot) => slot.id));
  const hidden = (Object.keys(WIDGETS) as WidgetId[]).filter((id) => !visible.has(id));
  const widget = (id: WidgetId, size: WidgetSize, isHidden: boolean) => {
    const c = content[id];
    const sizeButtons = SIZES.map(
      (value) => `<button type="button" class="xs" data-size="${value}" aria-pressed="${value === size}" title="${SIZE_LABELS[value]}">${value.toUpperCase()}</button>`,
    ).join("");
    return `<section class="card widget" data-widget="${id}" data-size="${size}" aria-labelledby="w-${id}"${isHidden ? " hidden" : ""}>
      <div class="w-edit" aria-label="Arrange ${escapeHtml(c.title)}">
        <span class="w-grip" aria-hidden="true">${icon("grip")}</span>
        <span class="w-sizes" role="group" aria-label="Width">${sizeButtons}</span>
        <span class="w-moves"><button type="button" class="icon-btn" data-move="-1" aria-label="Move ${escapeHtml(c.title)} earlier">${icon("chevron", "i up")}</button><button type="button" class="icon-btn" data-move="1" aria-label="Move ${escapeHtml(c.title)} later">${icon("chevron", "i down")}</button></span>
        <button type="button" class="icon-btn" data-hide aria-label="Hide ${escapeHtml(c.title)}">${icon("close")}</button>
      </div>
      <div class="card-head row"><div class="card-title"><h2 id="w-${id}">${escapeHtml(c.title)}</h2>${c.count ? `<span class="badge tabular">${c.count}</span>` : ""}</div>${c.more ? `<a class="more" href="${c.more.href}">${escapeHtml(c.more.label)}${icon("arrow")}</a>` : ""}</div>
      <div class="card-body">${c.body}</div>
    </section>`;
  };
  const tray = (Object.keys(WIDGETS) as WidgetId[])
    .map((id) => `<button type="button" class="secondary sm" data-add="${id}"${visible.has(id) ? " hidden" : ""}>${icon("plus")}${escapeHtml(WIDGETS[id])}</button>`)
    .join("");
  return `<div class="board" data-board>
      ${slots.map((slot) => widget(slot.id, slot.size, false)).join("")}
      ${hidden.map((id) => widget(id, "s", true)).join("")}
    </div>
    <form class="board-bar" method="post" action="/panel/board" data-board-bar hidden>
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="layout" value="">
      <div class="board-tray"><span class="muted small">Add a widget</span>${tray}</div>
      <div class="board-actions">
        <button type="submit" name="reset" value="1" class="ghost sm">Reset to default</button>
        <a class="button secondary sm" href="/panel">Cancel</a>
        <button type="submit" class="sm" data-save>Save layout</button>
      </div>
    </form>`;
}

export const BOARD_STYLE = `<style>
.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:stretch;margin-bottom:16px}
.widget{margin:0;display:flex;flex-direction:column;position:relative}
.widget>.card-body{flex:1}
.widget[data-size=s]{grid-column:span 1}
.widget[data-size=m]{grid-column:span 2}
.widget[data-size=l]{grid-column:1/-1}
@media (max-width:1100px){.board{grid-template-columns:repeat(2,minmax(0,1fr))}.widget[data-size=m]{grid-column:1/-1}}
@media (max-width:640px){.board{grid-template-columns:minmax(0,1fr)}.widget[data-size]{grid-column:1/-1}}
.w-edit{display:none}
.editing .widget{cursor:grab;box-shadow:0 0 0 1.5px var(--faint)}
.editing .widget.dragging{opacity:.4}
.editing .widget.drop-before{box-shadow:-3px 0 0 0 var(--fg),0 0 0 1.5px var(--faint)}
.editing .widget.drop-after{box-shadow:3px 0 0 0 var(--fg),0 0 0 1.5px var(--faint)}
.editing .w-edit{display:flex;align-items:center;gap:6px;padding:10px 12px 0}
.editing .widget>.card-body{pointer-events:none;opacity:.55;max-height:220px;overflow:hidden}
.w-grip{color:var(--faint);display:grid;place-items:center;width:20px}
.w-sizes{display:inline-flex;gap:2px;padding:2px;border-radius:999px;background:var(--default)}
.w-sizes button{height:24px;min-width:28px;padding:0 8px;background:none;color:var(--muted)}
.w-sizes button[aria-pressed=true]{background:var(--surface);color:var(--fg);box-shadow:var(--shadow)}
.w-moves{display:inline-flex;gap:4px;margin-left:auto}
.w-edit .icon-btn{width:28px;height:28px}
.w-edit .icon-btn .i{width:14px;height:14px}
.w-edit .i.up{transform:rotate(-90deg)}.w-edit .i.down{transform:rotate(90deg)}
.board-bar{position:sticky;bottom:16px;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 12px;border-radius:16px;background:var(--surface);box-shadow:var(--shadow-lg)}
.board-tray{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.board-tray .muted{margin-right:4px}
.board-actions{display:flex;gap:8px;margin-left:auto}
@media (prefers-reduced-motion:no-preference){.widget{transition:box-shadow .15s,opacity .15s}}
</style>`;

export const BOARD_SCRIPT = `<script>
(function () {
  var board = document.querySelector("[data-board]");
  var bar = document.querySelector("[data-board-bar]");
  var toggle = document.querySelector("[data-board-edit]");
  if (!board || !bar || !toggle) return;
  var widgets = function () { return Array.prototype.slice.call(board.querySelectorAll(".widget")); };
  var shown = function () { return widgets().filter(function (w) { return !w.hidden; }); };
  function start() {
    board.classList.add("editing"); bar.hidden = false; toggle.hidden = true;
    widgets().forEach(function (w) { w.draggable = true; });
  }
  toggle.addEventListener("click", start);
  board.addEventListener("click", function (event) {
    var button = event.target.closest("button"); if (!button) return;
    var w = button.closest(".widget"); if (!w) return;
    if (button.dataset.size) {
      w.dataset.size = button.dataset.size;
      w.querySelectorAll(".w-sizes button").forEach(function (b) { b.setAttribute("aria-pressed", String(b === button)); });
    } else if (button.dataset.move) {
      var list = shown(); var i = list.indexOf(w); var j = i + Number(button.dataset.move);
      if (j < 0 || j >= list.length) return;
      if (j < i) board.insertBefore(w, list[j]); else board.insertBefore(w, list[j].nextSibling);
      button.focus();
    } else if (button.hasAttribute("data-hide")) {
      w.hidden = true;
      var add = bar.querySelector('[data-add="' + w.dataset.widget + '"]'); if (add) add.hidden = false;
    }
  });
  bar.addEventListener("click", function (event) {
    var add = event.target.closest("[data-add]"); if (!add) return;
    var w = board.querySelector('[data-widget="' + add.dataset.add + '"]'); if (!w) return;
    var list = shown(); var last = list[list.length - 1];
    board.insertBefore(w, last ? last.nextSibling : board.firstChild);
    w.hidden = false; add.hidden = true; w.scrollIntoView({ block: "nearest" });
  });
  bar.addEventListener("submit", function () {
    bar.elements.layout.value = JSON.stringify(shown().map(function (w) { return { id: w.dataset.widget, size: w.dataset.size }; }));
  });
  var dragged = null;
  function clearMarks() { widgets().forEach(function (w) { w.classList.remove("drop-before", "drop-after"); }); }
  board.addEventListener("dragstart", function (event) {
    if (!board.classList.contains("editing")) return;
    dragged = event.target.closest(".widget"); if (!dragged) return;
    dragged.classList.add("dragging"); event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragged.dataset.widget);
  });
  board.addEventListener("dragover", function (event) {
    var w = event.target.closest(".widget"); if (!dragged || !w || w === dragged) return;
    event.preventDefault(); clearMarks();
    var box = w.getBoundingClientRect();
    w.classList.add(event.clientX < box.left + box.width / 2 ? "drop-before" : "drop-after");
  });
  board.addEventListener("drop", function (event) {
    var w = event.target.closest(".widget"); if (!dragged || !w || w === dragged) return;
    event.preventDefault();
    board.insertBefore(dragged, w.classList.contains("drop-before") ? w : w.nextSibling);
    clearMarks();
  });
  board.addEventListener("dragend", function () { if (dragged) dragged.classList.remove("dragging"); dragged = null; clearMarks(); });
})();
</script>`;
