// Type declarations for prompts.js — see that file for behavior notes.
// Kept by hand (the .js is the runtime source of truth, inlined verbatim into
// widget HTML by scripts/build-widgets.mjs); update both together.

import type { BucketGroup, CourseView, ItemSummary, Plan, Brief, SourceStatus } from "../mcp/door-contracts";
import type { ChecklistItem } from "./checklist";

// Each parameter is a Pick of only the fields the builder actually reads —
// that is the real contract of a pure formatter, and it lets callers (and
// tests) pass a plan/item/brief slice instead of a whole door-contracts
// payload.

export function discussBriefPrompt(brief: Pick<Brief, "title" | "id" | "kind">): string;
export function decomposeAssignmentPrompt(
  course: Pick<CourseView, "code">,
  bucket: Pick<BucketGroup, "label">,
  item: Pick<ItemSummary, "source" | "itemId">,
): string;
export function askStaffOpinionPrompt(course: Pick<CourseView, "code">, bucket: Pick<BucketGroup, "label">): string;
export function whatMattersPrompt(changes: { events: unknown[]; nextCursor: string }): string;
export function planAroundPrompt(item: Pick<ItemSummary, "title" | "source" | "itemId" | "dueAt">): string;
// plan.kind is only ever compared with === "weekly", never assumed to be a
// valid Plan["kind"] — a plain string is the honest type here (and lets
// callers pass an inferred, non-`as const` literal).
type PlanKindSubject = { kind: string; subject: Plan["subject"] };

export function replanRestPrompt(plan: PlanKindSubject, remainingTexts: string[]): string;
export function fixSourcePrompt(source: Pick<SourceStatus, "label" | "id" | "lastError">): string;
export function ackBriefSummary(brief: Pick<Brief, "title" | "id">): string;
export function ackAllBriefsSummary(count: number): string;
export function checklistToggleSummary(
  plan: PlanKindSubject,
  item: Pick<ChecklistItem, "text">,
  checkedNow: boolean,
  done: number,
  total: number,
): string;
