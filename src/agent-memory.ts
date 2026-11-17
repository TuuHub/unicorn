// Memory v2 (ADR-0047): the agent-facing memory model, layered on the D1 MemoryStore
// (src/memory.ts, ADR-0024's capped notes) that already backs `remember`.
//
// Shaped after Hermes Agent's bounded MEMORY.md / USER.md: a few small, named stores of
// short entries, read in full at session start (frozen into the door's MCP `instructions`)
// and edited by the client agent through one `memory` tool with add / patch / remove
// operations. Substring-addressed edits (patch/remove by `old_text`) mean the agent never
// has to re-send a whole note, so two clients editing at once rarely collide — and when they
// do, the write retries on the store's optimistic-concurrency check.
//
// The stores, and who writes each:
//   user         who the user is: degree, year, goals, preferences   — the client agent
//   notes        the agent's working notes: follow-ups, decisions    — the client agent
//   term         this term's units, from synced sources              — unicorn's kernel, every cycle
//   corrections  verbatim standing rules, via `remember`             — the client agent
//
// Character limits are chosen so all four together stay inside ADR-0024's 4k-token cap even
// for CJK text (6000 chars / 1.5 chars-per-token = 4000), so a full read always fits.

import type { ActivityLog } from "./activity";
import { type MemoryNote, type MemoryStore, MemoryConflictError } from "./memory";

export type MemoryTarget = "user" | "notes" | "term" | "corrections";

export interface MemoryTargetSpec {
  target: MemoryTarget;
  domain: string;
  limit: number;
  title: string;
  purpose: string;
  // "section": entries separated by a line holding only "§" (multi-line entries allowed).
  // "line":    one entry per line — the format `remember` has always written.
  split: "section" | "line";
  agentWritable: boolean;
}

export const MEMORY_TARGETS: Record<MemoryTarget, MemoryTargetSpec> = {
  user: {
    target: "user",
    domain: "user",
    limit: 1400,
    title: "USER PROFILE",
    purpose: "who the user is — university, degree, year, goals this term, how they like to work, language",
    split: "section",
    agentWritable: true,
  },
  notes: {
    target: "notes",
    domain: "notes",
    limit: 2200,
    title: "NOTES",
    purpose: "your working notes — what the user is following up, decisions made, conventions per course",
    split: "section",
    agentWritable: true,
  },
  term: {
    target: "term",
    domain: "term",
    limit: 1000,
    title: "TERM",
    purpose: "this term's units, maintained automatically by unicorn from synced sources",
    split: "line",
    agentWritable: false,
  },
  corrections: {
    target: "corrections",
    domain: "corrections",
    limit: 1400,
    title: "CORRECTIONS",
    purpose: "verbatim standing rules the user stated (written by remember)",
    split: "line",
    agentWritable: true,
  },
};

export const MEMORY_TARGET_ORDER: MemoryTarget[] = ["user", "notes", "term", "corrections"];
const SECTION_DELIMITER = "\n§\n";

export interface MemoryOperation {
  action: "add" | "patch" | "remove";
  content?: string;
  old_text?: string;
}

export interface MemoryView {
  target: MemoryTarget;
  title: string;
  purpose: string;
  entries: string[];
  chars: number;
  limit: number;
  usagePercent: number;
  updatedAt: string | null;
  writable: boolean;
}

export class MemoryOperationError extends Error {
  constructor(
    readonly code: "readonly_target" | "not_found" | "ambiguous" | "duplicate" | "over_limit" | "blocked_content" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "MemoryOperationError";
  }
}

export function splitEntries(content: string, split: MemoryTargetSpec["split"]): string[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }
  if (split === "line") {
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return trimmed
    .split(/\n?^§$\n?/m)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function joinEntries(entries: string[], split: MemoryTargetSpec["split"]): string {
  return entries.join(split === "line" ? "\n" : SECTION_DELIMITER);
}

export function toView(spec: MemoryTargetSpec, note: MemoryNote | null): MemoryView {
  const content = note?.content ?? "";
  const entries = splitEntries(content, spec.split);
  const chars = joinEntries(entries, spec.split).length;
  return {
    target: spec.target,
    title: spec.title,
    purpose: spec.purpose,
    entries,
    chars,
    limit: spec.limit,
    usagePercent: Math.round((chars / spec.limit) * 100),
    updatedAt: note && note.content ? note.updatedAt : null,
    writable: spec.agentWritable,
  };
}

export async function readAllMemory(store: MemoryStore): Promise<MemoryView[]> {
  const notes = await store.list();
  const byDomain = new Map(notes.map((note) => [note.domain, note]));
  return MEMORY_TARGET_ORDER.map((target) => {
    const spec = MEMORY_TARGETS[target];
    return toView(spec, byDomain.get(spec.domain) ?? null);
  });
}

// Memory is read back into the agent's context verbatim, so an entry is a prompt-injection
// vector: a forum post the agent saves could carry instructions, and invisible Unicode can
// hide them from the person reviewing memory in the panel. Both are rejected at write time.
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u;
const INJECTION = [
  /ignore (all |any )?(previous|prior|above) (instructions|messages|rules)/i,
  /disregard (all |any )?(previous|prior|above)/i,
  /you are now (?!a student)/i,
  /<\/?(system|instructions?)>/i,
  /\b(exfiltrate|send (this|the|all) (data|memory|tokens?) to)\b/i,
];

export function screenEntry(content: string): void {
  if (INVISIBLE.test(content)) {
    throw new MemoryOperationError("blocked_content", "Memory entries cannot contain invisible or bidirectional-control Unicode characters.");
  }
  for (const pattern of INJECTION) {
    if (pattern.test(content)) {
      throw new MemoryOperationError(
        "blocked_content",
        "That entry reads like an instruction to an AI rather than a fact about the user. Memory stores facts and preferences only — rephrase it as a plain statement.",
      );
    }
  }
}

function normalizeEntry(content: string, split: MemoryTargetSpec["split"]): string {
  const trimmed = content.trim();
  if (split === "line") {
    return trimmed.replace(/\s+/g, " ");
  }
  // A literal "§" line inside an entry would split it in two on the next read.
  return trimmed.replace(/^§$/gm, "§ ");
}

/** Applies operations in order to a copy of `entries`; throws MemoryOperationError on the first bad one. */
export function applyOperations(spec: MemoryTargetSpec, entries: string[], operations: MemoryOperation[], today: string): string[] {
  const next = [...entries];
  for (const operation of operations) {
    if (operation.action === "add") {
      const raw = operation.content?.trim();
      if (!raw) {
        throw new MemoryOperationError("invalid", "add needs non-empty content.");
      }
      screenEntry(raw);
      let entry = normalizeEntry(raw, spec.split);
      if (spec.target === "corrections" && !/^- \[\d{4}-\d{2}-\d{2}\]/.test(entry)) {
        entry = `- [${today}] ${entry.replace(/^-\s*/, "")}`;
      }
      if (next.some((existing) => existing === entry || existing.includes(raw))) {
        throw new MemoryOperationError("duplicate", "That entry is already in memory — no duplicate added.");
      }
      next.push(entry);
      continue;
    }
    const oldText = operation.old_text?.trim();
    if (!oldText) {
      throw new MemoryOperationError("invalid", `${operation.action} needs old_text: a unique substring of the entry to change.`);
    }
    // An exact whole-entry match wins over substring matches, so the panel (which sends the
    // full entry) and an agent quoting a whole short entry never hit "ambiguous".
    const exact = next.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry === oldText);
    const matches = exact.length === 1 ? exact : next.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(oldText));
    if (matches.length === 0) {
      throw new MemoryOperationError("not_found", `No ${spec.target} entry contains "${clip(oldText, 60)}". Call get_memory to see the live entries.`);
    }
    if (matches.length > 1) {
      throw new MemoryOperationError("ambiguous", `"${clip(oldText, 60)}" matches ${matches.length} ${spec.target} entries — use a longer, unique substring.`);
    }
    const { entry, index } = matches[0]!;
    if (operation.action === "remove") {
      next.splice(index, 1);
      continue;
    }
    // patch: replace one span inside one entry.
    if (entry.split(oldText).length - 1 !== 1) {
      throw new MemoryOperationError("ambiguous", `"${clip(oldText, 60)}" occurs more than once inside that entry — use a longer substring.`);
    }
    const replacement = operation.content ?? "";
    screenEntry(replacement);
    const patched = normalizeEntry(entry.replace(oldText, replacement), spec.split);
    if (patched) {
      next[index] = patched;
    } else {
      next.splice(index, 1);
    }
  }
  return next;
}

export interface MemoryWriteResult {
  view: MemoryView;
  applied: number;
  before: string[];
}

/**
 * Applies a batch of operations to one target, atomically: either every operation lands or
 * none does. Over-limit batches are rejected (never silently trimmed) so the agent consolidates
 * deliberately — except `corrections`, whose writer (`remember`) has always dropped the oldest
 * line to make room, and keeps doing so via recordCorrection.
 */
export async function writeMemory(
  store: MemoryStore,
  target: MemoryTarget,
  operations: MemoryOperation[],
  options: { now?: Date; allowReadonly?: boolean } = {},
): Promise<MemoryWriteResult> {
  const spec = MEMORY_TARGETS[target];
  if (!spec.agentWritable && !options.allowReadonly) {
    throw new MemoryOperationError(
      "readonly_target",
      `${spec.title} is maintained automatically by unicorn from your synced sources. Put corrections about it in notes instead.`,
    );
  }
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const note = await store.get(spec.domain);
    const entries = splitEntries(note.content, spec.split);
    const next = applyOperations(spec, entries, operations, today);
    const content = joinEntries(next, spec.split);
    if (content.length > spec.limit) {
      throw new MemoryOperationError(
        "over_limit",
        `${spec.title} would be ${content.length}/${spec.limit} chars. Consolidate in the same call: remove stale entries or patch several into one, then add.`,
      );
    }
    try {
      const saved = await store.save(spec.domain, content, note.content ? note.updatedAt : undefined);
      return { view: toView(spec, saved), applied: operations.length, before: entries };
    } catch (error) {
      if (error instanceof MemoryConflictError && attempt < 2) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Memory write conflicted three times.");
}

/** The frozen snapshot the door puts in its MCP `instructions` at session start. */
export function renderMemorySnapshot(views: MemoryView[], now: Date = new Date()): string {
  const blocks = views.map((view) => {
    const header = `${view.title} — ${view.purpose} [${view.chars}/${view.limit} chars]`;
    if (view.entries.length === 0) {
      return `${header}\n(empty)`;
    }
    const stale = staleEntries(view, now);
    const staleLine = stale.length ? `\n(Possibly out of date, check with the user or remove: ${stale.map((entry) => `"${clip(entry, 50)}"`).join(", ")})` : "";
    return `${header}\n${view.entries.join(view.target === "term" || view.target === "corrections" ? "\n" : "\n§\n")}${staleLine}`;
  });
  return blocks.join("\n\n");
}

/** One-line nudge appended to door tool results, so memory upkeep is never more than a glance away. */
export function memoryNudge(views: MemoryView[], now: Date = new Date()): string {
  const user = views.find((view) => view.target === "user");
  const notes = views.find((view) => view.target === "notes");
  if (!user || user.entries.length === 0) {
    return 'Memory: the USER PROFILE is empty. Run the onboard playbook, or save what you learn about the user with memory({target:"user", operations:[{action:"add", content:"..."}]}).';
  }
  const full = [user, notes].filter((view): view is MemoryView => Boolean(view) && view!.usagePercent >= 80);
  if (full.length > 0) {
    return `Memory: ${full.map((view) => `${view.title} is ${view.usagePercent}% full`).join(", ")}. Consolidate (patch/remove) before adding more.`;
  }
  const stale = notes ? staleEntries(notes, now) : [];
  if (stale.length > 0) {
    return `Memory: ${stale.length} NOTES entr${stale.length === 1 ? "y is" : "ies are"} over ${STALE_DAYS} days old. When the conversation touches them, check they still hold, then patch or remove.`;
  }
  return 'Memory: if this turn taught you something durable (a preference, a follow-up, a decision), save it now with memory({target:"user"|"notes", ...}).';
}

// A NOTES entry that starts with a date ("2026-11-06: asked for an extension") is a follow-up;
// after three weeks it has usually resolved one way or the other.
export const STALE_DAYS = 21;

/** The date an entry opens with, as in "2026-11-06: ..." or a correction's "- [2026-11-06] ...". */
export function entryDate(entry: string): string | null {
  return entry.match(/^(?:- \[)?(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null;
}

export function staleEntries(view: MemoryView, now: Date): string[] {
  if (view.target !== "notes") return [];
  const cutoff = now.getTime() - STALE_DAYS * 86_400_000;
  return view.entries.filter((entry) => {
    const date = entryDate(entry);
    return date !== null && Date.parse(`${date}T00:00:00Z`) < cutoff;
  });
}

export function diffEntries(before: string[], after: string[]): { added: string[]; removed: string[] } {
  return { added: after.filter((entry) => !before.includes(entry)), removed: before.filter((entry) => !after.includes(entry)) };
}

/**
 * Runs a write to one target and logs what it changed as a `memory` activity row, so the panel
 * can show who changed which entries and undo it. A write that changed nothing logs nothing.
 */
export async function trackMemoryWrite<T>(
  store: MemoryStore,
  activity: ActivityLog | undefined,
  target: MemoryTarget,
  who: { actor: string | null; via: string | null },
  write: () => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const spec = MEMORY_TARGETS[target];
  const before = splitEntries((await store.get(spec.domain)).content, spec.split);
  const result = await write();
  if (activity) {
    const after = splitEntries((await store.get(spec.domain)).content, spec.split);
    const { added, removed } = diffEntries(before, after);
    if (added.length || removed.length) {
      await activity.record({ kind: "memory", name: target, status: "ok", actor: who.actor, via: who.via, detail: { added, removed, ...extra } }).catch(() => undefined);
    }
  }
  return result;
}

/**
 * The operations that put back what a logged change did. An edit (added and removed side by
 * side) is patched back in place, so the entry keeps its position; the rest is removed or re-added.
 */
export function undoOperations(change: { added: string[]; removed: string[] }): MemoryOperation[] {
  const pairs = Math.min(change.added.length, change.removed.length);
  return [
    ...change.added.slice(0, pairs).map((entry, index): MemoryOperation => ({ action: "patch", old_text: entry, content: change.removed[index] })),
    ...change.added.slice(pairs).map((entry): MemoryOperation => ({ action: "remove", old_text: entry })),
    ...change.removed.slice(pairs).map((entry): MemoryOperation => ({ action: "add", content: entry })),
  ];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
