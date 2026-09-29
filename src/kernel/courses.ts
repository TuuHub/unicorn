// Course resolver + structural labelling (ADR-0036). Pure functions here are
// heavily unit-tested; labelStructure is the only function that touches D1.

// A unit code: 2-5 letters then 3-5 digits, with an optional trailing letter
// (e.g. "FIT2004", "COMP1511", "CHEM1011A"), allowing at most one separator
// between the letters and digits (e.g. "FIT 2004"). Captured in three groups
// so the separator itself can be dropped from the result.
const COURSE_CODE_PATTERN = /^([A-Z]{2,5})[\s_-]?(\d{3,5})([A-Z]?)/;

// Item kinds the campus plugins use for assessable work. A course-scoped item
// of any other kind (course itself, email, generic thread) lands in the
// course's `general` bucket instead of an assignment-specific one.
export const ASSESSMENT_KINDS = new Set(["assessment", "assignment", "quiz"]);

// Uppercases, then matches the leading unit code and discards everything
// after it — offering suffixes like "_S2_2026", "-T3-2025", or a trailing
// " S1 2026" (Ed's `course.code` is a full offering string, e.g.
// "FIT2099 S1 2026"), plus a code split by a stray space (" fit 2004 ").
// Returns null when no code is found.
export function normalizeCourseCode(raw: string): string | null {
  const compact = raw.trim().toUpperCase();
  const match = compact.match(COURSE_CODE_PATTERN);
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

// Normalizes a term/offering string ("S2_2026", "s2 2026", "S2  2026") to a
// single canonical form ("S2 2026"). Returns null for empty input.
export function normalizeTerm(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const cleaned = raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return cleaned || null;
}

// Lowercase kebab-case slug for an assessment title, used as the leaf of a
// `course/<CODE>/<slug>` bucket path. Capped at 48 chars (buckets are ids,
// not display labels).
export function bucketSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 48).replace(/-+$/g, "");
}

// Matches an Ed thread category (or similar) to one of a course's assessment
// titles: normalised equality first, else a unique word-boundary prefix
// match, else null (ambiguous means "don't guess" — the ladder never picks
// between two equally-good candidates).
export function matchCategoryToAssessment(category: string, assessmentTitles: string[]): string | null {
  const categorySlug = bucketSlug(category);
  if (!categorySlug) {
    return null;
  }

  const exact = assessmentTitles.find((title) => bucketSlug(title) === categorySlug);
  if (exact) {
    return exact;
  }

  const prefixMatches = assessmentTitles.filter((title) => {
    const titleSlug = bucketSlug(title);
    return titleSlug.startsWith(`${categorySlug}-`) || categorySlug.startsWith(`${titleSlug}-`);
  });
  return prefixMatches.length === 1 ? prefixMatches[0]! : null;
}

// --- Structural labelling --------------------------------------------------

interface ItemRow {
  source: string;
  item_id: string;
  kind: string;
  title: string;
  course: string | null;
  bucket: string | null;
  labeled_by: string | null;
}

interface FacetJoinRow {
  source: string;
  item_id: string;
  data_json: string;
}

function itemKey(source: string, itemId: string): string {
  return `${source}\u0000${itemId}`;
}

// Runs after every ingest cycle (ADR-0036): labels every active item whose
// labeled_by is NULL or 'structure' with a course code and bucket, computed
// deterministically from facets already on the item — no LLM, no regex over
// free text. Items with no resolvable course are left unlabeled for the
// triage routine. Batched: a handful of SELECTs plus one batched UPDATE
// write, not N+1 per-item round trips.
export async function labelStructure(db: D1Database): Promise<{ labeled: number }> {
  const [identityRows, candidateRows, membershipRows, mentionRows, categoryRows] = await Promise.all([
    db
      .prepare(
        `SELECT f.source, f.item_id, json_extract(f.data_json, '$.code') AS data_json
         FROM facets f
         JOIN items i ON i.source = f.source AND i.item_id = f.item_id
         WHERE f.type = 'course-identity' AND i.archived_at IS NULL`,
      )
      .all<{ source: string; item_id: string; data_json: string | null }>(),
    db
      .prepare(
        `SELECT source, item_id, kind, title, course, bucket, labeled_by
         FROM items
         WHERE archived_at IS NULL AND (labeled_by IS NULL OR labeled_by = 'structure')`,
      )
      .all<ItemRow>(),
    db
      .prepare(`SELECT source, item_id, json_extract(data_json, '$.course') AS data_json FROM facets WHERE type = 'course-membership'`)
      .all<FacetJoinRow>(),
    db.prepare(`SELECT source, item_id, data_json FROM facets WHERE type = 'course-mention'`).all<FacetJoinRow>(),
    db
      .prepare(`SELECT source, item_id, json_extract(data_json, '$.category') AS data_json FROM facets WHERE type = 'discussion-category'`)
      .all<{ source: string; item_id: string; data_json: string | null }>(),
  ]);

  const codeByCourseItem = new Map<string, string>();
  for (const row of identityRows.results) {
    const code = row.data_json ? normalizeCourseCode(row.data_json) : null;
    if (code) {
      codeByCourseItem.set(itemKey(row.source, row.item_id), code);
    }
  }

  const membershipByItem = new Map<string, string>();
  for (const row of membershipRows.results) {
    if (row.data_json) {
      membershipByItem.set(itemKey(row.source, row.item_id), row.data_json);
    }
  }

  const mentionCodesByItem = new Map<string, string[]>();
  for (const row of mentionRows.results) {
    const codes = (JSON.parse(row.data_json) as { codes?: unknown }).codes;
    const normalized = Array.isArray(codes)
      ? [...new Set(codes.filter((code): code is string => typeof code === "string").map(normalizeCourseCode).filter((code): code is string => code !== null))]
      : [];
    if (normalized.length > 0) {
      mentionCodesByItem.set(itemKey(row.source, row.item_id), normalized);
    }
  }

  const categoryByItem = new Map<string, string>();
  for (const row of categoryRows.results) {
    if (row.data_json) {
      categoryByItem.set(itemKey(row.source, row.item_id), row.data_json);
    }
  }

  function courseCodeFor(row: ItemRow): string | null {
    const key = itemKey(row.source, row.item_id);
    const membershipRef = membershipByItem.get(key);
    if (membershipRef) {
      const code = codeByCourseItem.get(itemKey(row.source, membershipRef));
      if (code) {
        return code;
      }
    }
    const ownCode = codeByCourseItem.get(key);
    if (ownCode) {
      return ownCode;
    }
    const mentions = mentionCodesByItem.get(key) ?? [];
    return mentions.length === 1 ? mentions[0]! : null;
  }

  const courseByKey = new Map<string, string | null>();
  for (const row of candidateRows.results) {
    courseByKey.set(itemKey(row.source, row.item_id), courseCodeFor(row));
  }

  const assessmentTitlesByCourse = new Map<string, string[]>();
  for (const row of candidateRows.results) {
    if (!ASSESSMENT_KINDS.has(row.kind)) {
      continue;
    }
    const code = courseByKey.get(itemKey(row.source, row.item_id));
    if (!code) {
      continue;
    }
    const titles = assessmentTitlesByCourse.get(code) ?? [];
    titles.push(row.title);
    assessmentTitlesByCourse.set(code, titles);
  }

  const updates: Array<{ source: string; itemId: string; course: string; bucket: string }> = [];
  for (const row of candidateRows.results) {
    const key = itemKey(row.source, row.item_id);
    const code = courseByKey.get(key);
    if (!code) {
      continue; // No resolvable course: leave unlabeled for the triage routine.
    }

    let bucket: string;
    if (ASSESSMENT_KINDS.has(row.kind)) {
      bucket = `course/${code}/${bucketSlug(row.title)}`;
    } else if (row.kind === "thread") {
      const category = categoryByItem.get(key);
      const matched = category ? matchCategoryToAssessment(category, assessmentTitlesByCourse.get(code) ?? []) : null;
      bucket = matched ? `course/${code}/${bucketSlug(matched)}` : `course/${code}/general`;
    } else {
      bucket = `course/${code}/general`;
    }
    // Runs every cycle over every item: rewriting an unchanged label costs a
    // row write per index and FTS trigger, which alone ate most of the D1
    // free-tier write quota. Only write labels that actually moved.
    if (row.labeled_by === "structure" && row.course === code && row.bucket === bucket) {
      continue;
    }
    updates.push({ source: row.source, itemId: row.item_id, course: code, bucket });
  }

  if (updates.length === 0) {
    return { labeled: 0 };
  }

  await db.batch(
    updates.map((update) =>
      db
        .prepare(`UPDATE items SET course = ?, bucket = ?, labeled_by = 'structure' WHERE source = ? AND item_id = ?`)
        .bind(update.course, update.bucket, update.source, update.itemId),
    ),
  );
  return { labeled: updates.length };
}
