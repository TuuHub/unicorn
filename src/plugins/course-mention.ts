import type { CapabilityBinding, Facet } from "../kernel/types";

// Monash-style unit codes: three uppercase letters, four digits (e.g. FIT2004).
// Deliberately case-sensitive — a lowercase "fit2004" in prose is far more often
// a false positive (a word, a variable name) than a genuine unit reference.
const UNIT_CODE_PATTERN = /\b[A-Z]{3}\d{4}\b/g;

/**
 * Extracts unit codes mentioned across the given texts (e.g. an email subject
 * and body). Case-sensitive by design (see UNIT_CODE_PATTERN), de-duplicated,
 * and sorted for a deterministic result any caller can diff or cache on.
 */
export function extractUnitCodes(...texts: Array<string | undefined | null>): string[] {
  const codes = new Set<string>();
  for (const text of texts) {
    if (!text) {
      continue;
    }
    for (const match of text.matchAll(UNIT_CODE_PATTERN)) {
      codes.add(match[0]);
    }
  }
  return [...codes].sort();
}

export interface CourseMentionFacet extends Facet {
  type: "course-mention";
  data: { codes: string[] };
  capabilities: CapabilityBinding[];
}

/**
 * Builds a `course-mention` facet from already-extracted unit codes. Returns
 * undefined when there are none — an item with no mention should carry no
 * facet at all, rather than an empty one (ADR-0016: facets are optional).
 *
 * No capability binding: `codes` is a list, not a single relation value (the
 * kernel's `relation` primitive expects one non-empty string — see
 * validPrimitiveValue in src/kernel/kernel.ts), and this facet only feeds
 * labelStructure's course resolution, never a change event. Same rationale
 * as ed-plugin.ts's `discussion-category` facet: structure, not a behavior
 * primitive.
 */
export function courseMentionFacet(codes: string[]): CourseMentionFacet | undefined {
  if (codes.length === 0) {
    return undefined;
  }
  return {
    type: "course-mention",
    data: { codes },
    capabilities: [],
  };
}
