// Type declarations for format.js — see that file for behavior notes.
// Kept by hand (the .js is the runtime source of truth, inlined verbatim into
// widget HTML by scripts/build-widgets.mjs); update both together.

import type { ChangeEvent } from "../mcp/door-contracts";

export function formatDateTime(
  iso: string | null | undefined,
  timezone?: string | null,
  options?: Intl.DateTimeFormatOptions,
): string | null;

export function formatRelativeTime(
  iso: string | null | undefined,
  now?: Date,
  timezone?: string | null,
  pastFacing?: boolean,
): string | null;

// Human label for a raw source id ("campus-moodle" -> "Moodle"), falling back
// to a title-cased id for a manifest source this map doesn't know about.
export function sourceLabel(id: string): string;

export function dayLabel(iso: string, now?: Date, timezone?: string | null): string;

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
  overdue?: boolean;
}

export function groupByDay<T extends { dueAt: string | null }>(
  items: T[],
  now?: Date,
  timezone?: string | null,
): Array<DayGroup<T>>;

// Only `type` is always read (it drives the switch); `before`/`after`/`title`
// are read one at a time depending on which branch matches, so each is
// optional — the honest parameter type for a pure formatter, not the full
// ChangeEvent.
export function phraseChange(
  event: {
    type: ChangeEvent["type"];
    before?: ChangeEvent["before"];
    after?: ChangeEvent["after"];
    title?: ChangeEvent["title"];
  },
  timezone?: string | null,
): string;
