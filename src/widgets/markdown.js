// Tiny safe markdown subset for brief and plan bodies (ADR-0037): headings,
// bold/italic, lists, task lists, links, inline code. Everything else is
// HTML-escaped, never passed through — this is the only place source text
// (a brief body, a plan) becomes HTML inside the widget, so raw tags and
// unsafe link schemes must never survive it.
//
// Dual-mode module: plain ES exports for `import` in tests and by
// scripts/build-widgets.mjs (which strips the `export` keyword when inlining
// this file into each widget's <script>); the `window.Unicorn.markdown`
// assignment at the bottom is what the inlined, non-module script actually
// calls.

const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto"]);

// Returns the url if it is safe to put in an href, otherwise null. A URL with
// no scheme (relative, or "#anchor") is allowed; anything else must be an
// allow-listed scheme — this is what stops "javascript:", "data:", "vbscript:".
function safeUrl(url) {
  const trimmed = String(url ?? "").trim();
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) return trimmed;
  return SAFE_URL_SCHEMES.has(schemeMatch[1].toLowerCase()) ? trimmed : null;
}

function renderInline(escapedText) {
  const codeSpans = [];
  let text = escapedText.replace(/`([^`]+)`/g, (_match, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    const href = safeUrl(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });

  text = text.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`);
  text = text.replace(/(?<![*_\w])\*([^*]+)\*(?!\w)|(?<![*_\w])_([^_]+)_(?!\w)/g, (_m, a, b) => `<em>${a ?? b}</em>`);

  return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)]);
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const TASK_RE = /^[-*]\s+\[( |x|X)\]\s+(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const ORDERED_RE = /^\d+\.\s+(.*)$/;

export function renderMarkdown(source) {
  const lines = String(source ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const html = [];
  let list = null; // { type: "ul" | "ol" | "task", items: string[] }

  function flushList() {
    if (!list) return;
    const tag = list.type === "ol" ? "ol" : "ul";
    const cls = list.type === "task" ? ' class="task-list"' : "";
    html.push(`<${tag}${cls}>${list.items.join("")}</${tag}>`);
    list = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      flushList();
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    const task = line.match(TASK_RE);
    if (task) {
      if (!list || list.type !== "task") {
        flushList();
        list = { type: "task", items: [] };
      }
      const checked = task[1].toLowerCase() === "x";
      list.items.push(
        `<li><label><input type="checkbox" disabled ${checked ? "checked" : ""}/> ${renderInline(escapeHtml(task[2]))}</label></li>`,
      );
      continue;
    }

    const bullet = line.match(BULLET_RE);
    if (bullet) {
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(`<li>${renderInline(escapeHtml(bullet[1]))}</li>`);
      continue;
    }

    const ordered = line.match(ORDERED_RE);
    if (ordered) {
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(`<li>${renderInline(escapeHtml(ordered[1]))}</li>`);
      continue;
    }

    flushList();
    html.push(`<p>${renderInline(escapeHtml(line))}</p>`);
  }
  flushList();
  return html.join("\n");
}

if (typeof window !== "undefined") {
  window.Unicorn = window.Unicorn || {};
  window.Unicorn.markdown = { renderMarkdown, escapeHtml };
}
