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
    const matches = next.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(oldText));
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
      return { view: toView(spec, saved), applied: operations.length };
    } catch (error) {
      if (error instanceof MemoryConflictError && attempt < 2) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Memory write conflicted three times.");
}

/** Replaces a whole target's content (the panel's edit form). Same limit and screening rules. */
export async function replaceMemory(store: MemoryStore, target: MemoryTarget, content: string, expectedUpdatedAt?: string): Promise<MemoryView> {
  const spec = MEMORY_TARGETS[target];
  const entries = splitEntries(content, spec.split);
  for (const entry of entries) {
    screenEntry(entry);
  }
  const joined = joinEntries(entries, spec.split);
  if (joined.length > spec.limit) {
    throw new MemoryOperationError("over_limit", `${spec.title} is ${joined.length}/${spec.limit} chars — shorten it before saving.`);
  }
  const saved = await store.save(spec.domain, joined, expectedUpdatedAt);
  return toView(spec, saved);
}

/** The frozen snapshot the door puts in its MCP `instructions` at session start. */
export function renderMemorySnapshot(views: MemoryView[]): string {
  const blocks = views.map((view) => {
    const header = `${view.title} — ${view.purpose} [${view.usagePercent}% — ${view.chars}/${view.limit} chars]`;
    if (view.entries.length === 0) {
      return `${header}\n(empty)`;
    }
    return `${header}\n${view.entries.join(view.target === "term" || view.target === "corrections" ? "\n" : "\n§\n")}`;
  });
  return blocks.join("\n\n");
}

/** One-line nudge appended to door tool results, so memory upkeep is never more than a glance away. */
export function memoryNudge(views: MemoryView[]): string {
  const user = views.find((view) => view.target === "user");
  const notes = views.find((view) => view.target === "notes");
  if (!user || user.entries.length === 0) {
    return 'Memory: the USER PROFILE is empty — run the onboard playbook, or save what you learn about the user with memory({target:"user", operations:[{action:"add", content:"..."}]}).';
  }
  const full = [user, notes].filter((view): view is MemoryView => Boolean(view) && view!.usagePercent >= 80);
  if (full.length > 0) {
    return `Memory: ${full.map((view) => `${view.title} is ${view.usagePercent}% full`).join(", ")} — consolidate (patch/remove) before adding more.`;
  }
  return 'Memory: if this turn taught you something durable (a preference, a follow-up, a decision), save it now with memory({target:"user"|"notes", ...}).';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
