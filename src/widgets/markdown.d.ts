// Type declarations for markdown.js — see that file for behavior notes.
// Kept by hand (the .js is the runtime source of truth, inlined verbatim into
// widget HTML by scripts/build-widgets.mjs); update both together.

export function escapeHtml(text: string | null | undefined): string;
export function renderMarkdown(source: string | null | undefined): string;
