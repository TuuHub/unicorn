// Checklist line utilities for the plan widget (ADR-0037, door-contracts.ts
// Plan.content): task lines are GitHub task items, "- [ ] text" / "- [x] text".
// Toggling one item must rewrite only that line — the rest of the student's
// plan markdown is untouched, including its exact whitespace and line order.
//
// Dual-mode module: see markdown.js for why this file also runs as a plain
// inlined script.

const TASK_LINE_RE = /^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.*)$/;

export function listChecklistItems(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const items = [];
  lines.forEach((line, index) => {
    const match = line.match(TASK_LINE_RE);
    if (match) {
      items.push({ line: index, checked: match[2].toLowerCase() === "x", text: match[4] });
    }
  });
  return items;
}

// Flips exactly one task line's [ ]/[x] and returns the whole document with
// only that line changed. Returns the input unchanged if lineIndex is not a
// task line (a stale index from a since-edited plan, say).
export function toggleChecklistLine(markdown, lineIndex) {
  const original = String(markdown ?? "");
  const lines = original.split("\n");
  const line = lines[lineIndex];
  if (line === undefined) return original;
  const match = line.match(TASK_LINE_RE);
  if (!match) return original;
  const [, prefix, mark, suffix, text] = match;
  const next = mark.trim() === "" ? "x" : " ";
  lines[lineIndex] = `${prefix}${next}${suffix}${text}`;
  return lines.join("\n");
}

export function checklistProgress(markdown) {
  const items = listChecklistItems(markdown);
  const done = items.filter((item) => item.checked).length;
  return { done, total: items.length };
}

if (typeof window !== "undefined") {
  window.Unicorn = window.Unicorn || {};
  window.Unicorn.checklist = { listChecklistItems, toggleChecklistLine, checklistProgress };
}
