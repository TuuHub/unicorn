// Gmail search scope (ADR-0036): university domains, course-code mentions, and a
// sender allowlist, inside the existing time window — never the whole inbox.
//
// buildGmailQuery is pure (no D1), so the interesting cases — escaping, empty
// domains — are unit-tested directly. Callers (runtime/cycle.ts) resolve the
// D1-backed inputs (course codes from course-identity facets, the settings
// row's domains/allowlist) and pass plain arrays in here.

import { normalizeCourseCode } from "../kernel/courses";
import type { PluginManifest, PluginManifestMcp } from "./declarative/plugin";

export interface GmailQueryInput {
  /** University domains, e.g. ["monash.edu", "student.monash.edu"]. */
  domains: string[];
  /** Known unit codes (course-identity facets), e.g. ["FIT2004"]. */
  courseCodes: string[];
  /** Individually allowlisted senders, e.g. ["unit-convenor@example.edu"]. */
  allowlist: string[];
  /** Gmail's `newer_than:<n>d` window. */
  windowDays: number;
}

// Gmail search tokens allow letters, digits, '.', '@', '-', '_' unescaped; a
// bare-word course code or an email/domain never legitimately needs anything
// else. Any other character (quotes, parens, boolean operators typed into the
// /settings textarea) is stripped rather than escaped — the safe thing to do
// with free text destined for a search query is to narrow the character set,
// not to try to quote every special case. An entry that becomes empty after
// stripping is dropped.
function sanitizeToken(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9.@_-]/g, "");
}

function sanitizeAll(values: string[]): string[] {
  return [...new Set(values.map(sanitizeToken).filter((value) => value.length > 0))];
}

// Builds the deterministic Gmail search string: the time window, ANDed with an
// OR of (mail from a university domain) / (mail mentioning a known course code)
// / (mail from an allowlisted sender). When every list is empty the query is
// just the time window — Gmail then scopes to the inbox default, which is an
// explicit, visible "nothing configured yet" rather than a silent full-inbox pull.
export function buildGmailQuery(input: GmailQueryInput): string {
  const windowDays = Number.isInteger(input.windowDays) && input.windowDays > 0 ? input.windowDays : 14;
  const domains = sanitizeAll(input.domains);
  const courseCodes = sanitizeAll(input.courseCodes);
  const allowlist = sanitizeAll(input.allowlist);

  const clauses: string[] = [];
  if (domains.length > 0) {
    clauses.push(group(domains.map((domain) => `from:${domain}`)));
  }
  if (courseCodes.length > 0) {
    clauses.push(group(courseCodes));
  }
  if (allowlist.length > 0) {
    clauses.push(group(allowlist.map((sender) => `from:${sender}`)));
  }

  const scope = clauses.length > 0 ? group(clauses) : "";
  return [`newer_than:${windowDays}d`, scope].filter(Boolean).join(" ");
}

function group(tokens: string[]): string {
  return tokens.length === 1 ? tokens[0]! : `(${tokens.join(" OR ")})`;
}

// The registrable domain of a base-URL host, as a default "university domain"
// when nothing is configured in /settings — a light heuristic (last two labels),
// not a public-suffix-list lookup: good enough for .edu / .edu.au hosts like
// "learning.monash.edu" -> "monash.edu", wrong for anything with a longer public
// suffix, which is why it's a *default*, always overridable in /settings.
export function registrableDomain(hostname: string): string | null {
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length < 2) {
    return null;
  }
  return labels.slice(-2).join(".");
}

// Canvas base URLs are commonly a shared SaaS host (`*.instructure.com`), which
// is not the student's own university domain — never used as a Gmail-scope
// default, even though it's a plausible-looking "base URL host".
const SHARED_LMS_HOSTS = ["instructure.com"];

function isSharedLmsHost(domain: string): boolean {
  return SHARED_LMS_HOSTS.some((shared) => domain === shared || domain.endsWith(`.${shared}`));
}

// Best-effort default domain list when /settings has none configured yet:
// prefer Moodle's base URL (almost always the university's own domain), then
// Canvas's only if it isn't a shared LMS SaaS host. Never throws on a
// malformed URL — just contributes nothing.
export function defaultUniversityDomains(baseUrls: Array<string | undefined>): string[] {
  const domains: string[] = [];
  for (const baseUrl of baseUrls) {
    if (!baseUrl) {
      continue;
    }
    try {
      const domain = registrableDomain(new URL(baseUrl).hostname);
      if (domain && !isSharedLmsHost(domain) && !domains.includes(domain)) {
        domains.push(domain);
      }
    } catch {
      // malformed base URL — contribute nothing, don't fail the cycle over it.
    }
  }
  return domains;
}

// Clones the Gmail manifest with its transport arguments' `query` replaced by a
// freshly computed one — the JSON preset (installed once, at Connect time) keeps
// a static default query, but the *effective* query is recomputed every cycle
// from current /settings scope and course codes.
// The D1-touching half (mirrors src/digest.ts's split): every distinct, already
// -normalised unit code any course-identity facet carries, regardless of source
// or archived state — a code a student took last term is still worth matching
// in old mail.
export async function loadKnownCourseCodes(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT DISTINCT json_extract(data_json, '$.code') AS code FROM facets WHERE type = 'course-identity'`)
    .all<{ code: string | null }>();
  const codes = new Set<string>();
  for (const row of rows.results) {
    const normalized = row.code ? normalizeCourseCode(row.code) : null;
    if (normalized) {
      codes.add(normalized);
    }
  }
  return [...codes].sort();
}

export function withGmailQuery(manifest: PluginManifest, query: string): PluginManifestMcp {
  if (!("transport" in manifest) || manifest.transport.type !== "mcp") {
    throw new Error(`withGmailQuery expects an mcp-transport manifest, got ${manifest.id}.`);
  }
  const clone = structuredClone(manifest) as PluginManifestMcp;
  clone.transport.arguments = { ...clone.transport.arguments, query };
  return clone;
}
