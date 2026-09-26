// Type declarations for checklist.js — see that file for behavior notes.
// Kept by hand (the .js is the runtime source of truth, inlined verbatim into
// widget HTML by scripts/build-widgets.mjs); update both together.

export interface ChecklistItem {
  line: number;
  checked: boolean;
  text: string;
}

export interface ChecklistProgress {
  done: number;
  total: number;
}

export function listChecklistItems(markdown: string): ChecklistItem[];
export function toggleChecklistLine(markdown: string, lineIndex: number): string;
export function checklistProgress(markdown: string): ChecklistProgress;
