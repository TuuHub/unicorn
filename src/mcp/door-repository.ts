// Door v2 (ADR-0035/0036) read/write queries. Everything here reads the
// items.course/bucket/topic/labeled_by columns structural labelling
// (src/kernel/courses.ts) already writes at ingest time — no course-membership
// join gymnastics like the pre-ADR-0036 admin repository still does.

import { ASSESSMENT_KINDS, normalizeCourseCode, normalizeTerm } from "../kernel/courses";
import { STAFF_ROLES } from "../kernel/staff-roles";
import type {
  Bucket,
  BucketGroup,
  ChangeEvent,
  ChangesPage,
  CourseMatch,
  CourseView,
  ItemSummary,
  LabeledBy,
  LifeView,
  Plan,
  PlanKind,
} from "./door-contracts";
import { LIFE_BUCKETS } from "./door-contracts";

export interface ChangesSinceInput {
  cursor?: string;
  limit: number;
  course?: string;
  types?: string[];
}

export interface SearchItemsInput {
  query: string;
  kind?: string;
  course?: string;
  since?: string;
  limit: number;
}

export interface UpcomingInput {
  days: number;
  course?: string;
  includeOverdue: boolean;
}

export interface LabelItemInput {
  source: string;
  itemId: string;
  bucket: string;
  topic?: string;
}

export interface LabelItemsResult {
  updated: number;
  unknownItems: string[]; // "source:itemId"
  invalid: Array<{ source: string; itemId: string; bucket: string; reason: string }>;
}

export interface RepoSourceStatus {
  id: string;
  label: string;
  lastSyncAt: string | null;
  lastError: string | null;
  items: number;
}

export interface DoorRepository {
  changesSince(input: ChangesSinceInput): Promise<ChangesPage>;
  course(code: string): Promise<CourseView>;
  life(): Promise<LifeView>;
  searchItems(input: SearchItemsInput): Promise<ItemSummary[]>;
  upcoming(input: UpcomingInput): Promise<ItemSummary[]>;
  getPlan(kind: PlanKind, subject: string): Promise<Plan | null>;
  savePlan(kind: PlanKind, subject: string, content: string): Promise<Plan>;
  plannedSubjects(kind: PlanKind, subjects: string[]): Promise<Set<string>>;
  labelItems(inputs: LabelItemInput[], by: LabeledBy): Promise<LabelItemsResult>;
  listKnownCourseCodes(): Promise<string[]>;
  unlabeledItems(limit: number): Promise<ItemSummary[]>;
  sourceStatus(): Promise<{ sources: RepoSourceStatus[]; latestCursor: string }>;
}

// --- shared item-summary projection -----------------------------------------

// One row per item, no fanout: the temporal/state values come from correlated
// subqueries (LIMIT 1) rather than a JOIN on facets, because a JOIN would
// duplicate the item row once per matching facet/capability (an item can
// legitimately carry more than one facet). author_role/pin_status/thread_type
// feed the same staff heuristic the admin repository uses for staff posts.
const ITEM_BASE_COLUMNS = `
  i.source, i.item_id, i.kind, i.title, i.url, i.timestamp, i.body,
  i.course, i.bucket, i.topic, i.labeled_by
`;

const ITEM_TEMPORAL_COLUMN = `
  (SELECT json_extract(f.data_json, '$.' || json_extract(b.value, '$.field'))
     FROM facets f, json_each(f.capabilities_json) b
     WHERE f.source = i.source AND f.item_id = i.item_id AND json_extract(b.value, '$.primitive') = 'temporal'
     LIMIT 1) AS due_at
`;

const ITEM_STATE_COLUMN = `
  (SELECT json_extract(f.data_json, '$.' || json_extract(b.value, '$.field'))
     FROM facets f, json_each(f.capabilities_json) b
     WHERE f.source = i.source AND f.item_id = i.item_id AND json_extract(b.value, '$.primitive') = 'state'
     LIMIT 1) AS state
`;

const ITEM_STAFF_COLUMNS = `
  (SELECT json_extract(f.data_json, '$.authorRole') FROM facets f
     WHERE f.source = i.source AND f.item_id = i.item_id AND f.type = 'author' LIMIT 1) AS author_role,
  (SELECT json_extract(f.data_json, '$.pinStatus') FROM facets f
     WHERE f.source = i.source AND f.item_id = i.item_id AND f.type = 'discussion-state' LIMIT 1) AS pin_status,
  json_extract(i.raw_json, '$.type') AS thread_type
`;

const ITEM_EXTRA_COLUMNS = `${ITEM_TEMPORAL_COLUMN}, ${ITEM_STATE_COLUMN}, ${ITEM_STAFF_COLUMNS}`;

interface ItemSummaryRow {
  source: string;
  item_id: string;
  kind: string;
  title: string;
  url: string | null;
  timestamp: string;
  body: string | null;
  course: string | null;
  bucket: string | null;
  topic: string | null;
  labeled_by: LabeledBy | null;
  due_at: string | null;
  state: string | null;
  author_role: string | null;
  pin_status: string | null;
  thread_type: string | null;
}

function isStaffRow(row: Pick<ItemSummaryRow, "author_role" | "pin_status" | "thread_type">): boolean {
  const role = row.author_role?.toLowerCase();
  return (role !== undefined && STAFF_ROLES.has(role)) || row.thread_type === "announcement" || row.pin_status === "pinned";
}

function snippetOf(body: string | null): string | null {
  if (!body) {
    return null;
  }
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return null;
  }
  return collapsed.length > 240 ? `${collapsed.slice(0, 239)}…` : collapsed;
}

function parseItemSummary(row: ItemSummaryRow): ItemSummary {
  return {
    source: row.source,
    itemId: row.item_id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    timestamp: row.timestamp,
    dueAt: row.due_at,
    state: row.state,
    course: row.course,
    bucket: row.bucket,
    topic: row.topic,
    labeledBy: row.labeled_by,
    unlabeled: row.bucket === null,
    staff: isStaffRow(row),
    snippet: snippetOf(row.body),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Wraps every whitespace-separated token in a quoted FTS5 string literal so
// operators (AND/OR/NOT/-/*), stray quotes, and CJK punctuation are always
// treated as literal text, never as query syntax — a raw FTS5 syntax error
// must never reach the caller.
function buildFtsQuery(raw: string): string | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}

function bucketLabel(bucket: string, assessmentTitle: string | null): string {
  const leaf = bucket.split("/").pop() ?? bucket;
  if (bucket.startsWith("life/")) {
    return { events: "Events", admin: "Admin", other: "Other" }[leaf] ?? titleCase(leaf);
  }
  if (leaf === "general") {
    return "General";
  }
  return assessmentTitle ?? titleCase(leaf);
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

// Groups already-labelled item summaries into BucketGroup[]: assessment
// buckets ordered by dueAt (nulls last), the general bucket always last.
function groupBuckets(items: ItemSummary[]): BucketGroup[] {
  const byBucket = new Map<string, ItemSummary[]>();
  for (const item of items) {
    if (!item.bucket) {
      continue;
    }
    const list = byBucket.get(item.bucket) ?? [];
    list.push(item);
    byBucket.set(item.bucket, list);
  }
  const groups: BucketGroup[] = [];
  for (const [bucket, bucketItems] of byBucket) {
    const assessment = bucketItems.find((item) => ASSESSMENT_KINDS.has(item.kind)) ?? null;
    const ordered = [
      ...bucketItems.filter((item) => ASSESSMENT_KINDS.has(item.kind)),
      ...bucketItems.filter((item) => !ASSESSMENT_KINDS.has(item.kind)).sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    ];
    groups.push({
      bucket,
      label: bucketLabel(bucket, assessment?.title ?? null),
      dueAt: assessment?.dueAt ?? null,
      state: assessment?.state ?? null,
      items: ordered,
    });
  }
  return groups.sort((a, b) => {
    const aGeneral = a.bucket.endsWith("/general");
    const bGeneral = b.bucket.endsWith("/general");
    if (aGeneral !== bGeneral) {
      return aGeneral ? 1 : -1;
    }
    if (a.dueAt === b.dueAt) {
      return a.bucket.localeCompare(b.bucket);
    }
    if (a.dueAt === null) {
      return 1;
    }
    if (b.dueAt === null) {
      return -1;
    }
    return a.dueAt.localeCompare(b.dueAt);
  });
}

// --- course() resolver -------------------------------------------------------

interface CourseIdentityRow {
  source: string;
  item_id: string;
  title: string;
  url: string | null;
  code: string | null;
  term: string | null;
  status: string | null;
}

interface RelationRow {
  from_source: string;
  from_item_id: string;
  to_source: string;
  to_item_id: string;
}

interface CourseCandidate {
  source: string;
  itemId: string;
  title: string;
  url: string | null;
  term: string | null;
  status: string | null;
}

// Union-find over confirmed `same-course` relations: two course-identity
// items land in the same group when a relation links them, regardless of
// term — a confirmed relation always wins (resolver rung 1, ADR-0036).
function groupByRelation(candidates: CourseCandidate[], relations: RelationRow[]): CourseCandidate[][] {
  const key = (source: string, itemId: string) => `${source}\u0000${itemId}`;
  const parent = new Map<string, string>();
  for (const candidate of candidates) {
    parent.set(key(candidate.source, candidate.itemId), key(candidate.source, candidate.itemId));
  }
  function find(node: string): string {
    let root = node;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    return root;
  }
  for (const relation of relations) {
    const from = key(relation.from_source, relation.from_item_id);
    const to = key(relation.to_source, relation.to_item_id);
    if (parent.has(from) && parent.has(to)) {
      parent.set(find(from), find(to));
    }
  }
  const groups = new Map<string, CourseCandidate[]>();
  for (const candidate of candidates) {
    const root = find(key(candidate.source, candidate.itemId));
    const list = groups.get(root) ?? [];
    list.push(candidate);
    groups.set(root, list);
  }
  return [...groups.values()];
}

const LIFE_BUCKET_SET = new Set<string>(LIFE_BUCKETS);

// `course/<CODE>/<slug>` (known code) | `course/<CODE>/general` | one of the
// three life buckets. Returns the course the bucket implies (null for life),
// or null when the shape or code is invalid — the caller reports, never throws.
function parseBucketShape(bucket: string, knownCodes: Set<string>): { course: string | null } | null {
  if (LIFE_BUCKET_SET.has(bucket)) {
    return { course: null };
  }
  const match = bucket.match(/^course\/([^/]+)\/([^/]+)$/);
  if (!match) {
    return null;
  }
  const [, code, leaf] = match as [string, string, string];
  if (!knownCodes.has(code)) {
    return null;
  }
  if (leaf === "general") {
    return { course: code };
  }
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(leaf) ? { course: code } : null;
}

interface ChangeRow {
  seq: number;
  type: string;
  source: string;
  item_id: string;
  kind: string;
  title: string;
  url: string | null;
  field: string | null;
  before_json: string | null;
  after_json: string | null;
  topic: string | null;
  created_at: string;
  course: string | null;
  bucket: string | null;
}

function parseChangeEvent(row: ChangeRow): ChangeEvent {
  return {
    cursor: String(row.seq),
    type: row.type as ChangeEvent["type"],
    at: row.created_at,
    source: row.source,
    itemId: row.item_id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    course: row.course,
    bucket: row.bucket as Bucket | null,
    topic: row.topic,
    field: row.field,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null,
  };
}

interface StoredCycleSource {
  plugin: string;
  lastSyncAt: string;
  lastError: string | null;
}

interface StoredCycle {
  sources?: StoredCycleSource[];
}

const SOURCE_LABELS: Record<string, string> = {
  "campus-moodle": "Moodle",
  "campus-ed": "Ed",
  "campus-canvas": "Canvas",
  gmail: "Gmail",
};

function sourceLabel(id: string): string {
  return SOURCE_LABELS[id] ?? titleCase(id.replace(/^campus-/, ""));
}

export class D1DoorRepository implements DoorRepository {
  constructor(private readonly db: D1Database) {}

  async changesSince(input: ChangesSinceInput): Promise<ChangesPage> {
    const noCursor = input.cursor === undefined;
    const limit = noCursor ? 20 : input.limit;

    const conditions: string[] = [];
    const values: unknown[] = [];
    if (!noCursor) {
      conditions.push("c.seq > ?");
      values.push(Number(input.cursor));
    }
    if (input.course) {
      conditions.push("i.course = ?");
      values.push(normalizeCourseCode(input.course) ?? input.course.trim().toUpperCase());
    }
    if (input.types && input.types.length > 0) {
      conditions.push(`c.type IN (${input.types.map(() => "?").join(", ")})`);
      values.push(...input.types);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = noCursor ? "DESC" : "ASC";

    const rows = await this.db
      .prepare(
        `SELECT c.seq, c.type, c.source, c.item_id, c.kind, c.title, c.url, c.field, c.before_json, c.after_json, c.topic, c.created_at,
           i.course, i.bucket
         FROM changes c
         LEFT JOIN items i ON i.source = c.source AND i.item_id = c.item_id
         ${where}
         ORDER BY c.seq ${order}
         LIMIT ?`,
      )
      .bind(...values, limit + 1)
      .all<ChangeRow>();

    let pageRows = noCursor ? [...rows.results].reverse() : rows.results;
    const hasMore = pageRows.length > limit;
    if (hasMore) {
      pageRows = noCursor ? pageRows.slice(1) : pageRows.slice(0, limit);
    }

    const events = pageRows.map(parseChangeEvent);
    const nextCursor = events.length > 0 ? events[events.length - 1]!.cursor : input.cursor ?? "0";

    const counts: Record<string, number> = {};
    for (const event of events) {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
    }

    return { events, nextCursor, hasMore: noCursor ? false : hasMore, counts: counts as ChangesPage["counts"] };
  }

  async course(codeQuery: string): Promise<CourseView> {
    const queryCode = normalizeCourseCode(codeQuery) ?? codeQuery.trim().toUpperCase();
    const [identityRows, relationRows] = await Promise.all([
      this.db
        .prepare(
          `SELECT i.source, i.item_id, i.title, i.url,
             json_extract(f.data_json, '$.code') AS code,
             json_extract(f.data_json, '$.term') AS term,
             json_extract(f.data_json, '$.status') AS status
           FROM items i
           JOIN facets f ON f.source = i.source AND f.item_id = i.item_id AND f.type = 'course-identity'
           WHERE i.archived_at IS NULL`,
        )
        .all<CourseIdentityRow>(),
      this.db.prepare(`SELECT from_source, from_item_id, to_source, to_item_id FROM relations WHERE type = 'same-course'`).all<RelationRow>(),
    ]);

    const candidates: CourseCandidate[] = identityRows.results
      .filter((row) => normalizeCourseCode(row.code ?? "") === queryCode)
      .map((row) => ({ source: row.source, itemId: row.item_id, title: row.title, url: row.url, term: normalizeTerm(row.term), status: row.status }));

    const empty: CourseView = { query: codeQuery, code: null, title: null, term: null, ambiguous: false, matches: [], sources: [], buckets: [], unlabeled: [] };
    if (candidates.length === 0) {
      return empty;
    }

    const toMatch = (candidate: CourseCandidate): CourseMatch => ({
      code: queryCode,
      term: candidate.term,
      title: candidate.title,
      source: candidate.source,
      itemId: candidate.itemId,
      url: candidate.url,
    });
    const allMatches = candidates.map(toMatch);
    const sources = [...new Set(candidates.map((candidate) => candidate.source))];

    const groups = groupByRelation(candidates, relationRows.results);
    let resolved: CourseCandidate[] | null = groups.length === 1 ? groups[0]! : null;
    if (!resolved) {
      const active = groups.filter((group) => group.some((candidate) => candidate.status === "active"));
      resolved = active.length === 1 ? active[0]! : null;
    }
    if (!resolved) {
      return { query: codeQuery, code: queryCode, title: null, term: null, ambiguous: true, matches: allMatches, sources, buckets: [], unlabeled: [] };
    }

    const terms = new Set(resolved.map((candidate) => candidate.term).filter((term): term is string => term !== null));
    const term = terms.size === 1 ? [...terms][0]! : null;
    const title = resolved[0]!.title;

    const [bucketRows, unlabeledRows] = await Promise.all([
      this.db
        .prepare(
          `SELECT ${ITEM_BASE_COLUMNS}, ${ITEM_EXTRA_COLUMNS}
           FROM items i
           WHERE i.archived_at IS NULL AND i.course = ? AND i.bucket IS NOT NULL
           ORDER BY i.bucket, i.timestamp DESC`,
        )
        .bind(queryCode)
        .all<ItemSummaryRow>(),
      this.db
        .prepare(
          `SELECT ${ITEM_BASE_COLUMNS}, ${ITEM_EXTRA_COLUMNS}
           FROM items i
           LEFT JOIN facets men ON men.source = i.source AND men.item_id = i.item_id AND men.type = 'course-mention'
           WHERE i.archived_at IS NULL AND i.bucket IS NULL
             AND (i.course = ? OR (men.data_json IS NOT NULL AND EXISTS (
               SELECT 1 FROM json_each(men.data_json, '$.codes') c WHERE upper(c.value) = ?
             )))
           ORDER BY i.timestamp DESC
           LIMIT 50`,
        )
        .bind(queryCode, queryCode)
        .all<ItemSummaryRow>(),
    ]);

    return {
      query: codeQuery,
      code: queryCode,
      title,
      term,
      ambiguous: false,
      matches: allMatches,
      sources,
      buckets: groupBuckets(bucketRows.results.map(parseItemSummary)),
      unlabeled: unlabeledRows.results.map(parseItemSummary),
    };
  }

  async life(): Promise<LifeView> {
    const [bucketRows, unlabeledRows] = await Promise.all([
      this.db
        .prepare(
          `SELECT ${ITEM_BASE_COLUMNS}, ${ITEM_EXTRA_COLUMNS}
           FROM items i
           WHERE i.archived_at IS NULL AND i.course IS NULL AND i.bucket IN (?, ?, ?)
           ORDER BY i.bucket, i.timestamp DESC`,
        )
        .bind(...LIFE_BUCKETS)
        .all<ItemSummaryRow>(),
      this.db
        .prepare(
          `SELECT ${ITEM_BASE_COLUMNS}, ${ITEM_EXTRA_COLUMNS}
           FROM items i
           WHERE i.archived_at IS NULL AND i.course IS NULL AND i.bucket IS NULL
           ORDER BY i.timestamp DESC
           LIMIT 50`,
        )
        .all<ItemSummaryRow>(),
    ]);

    const items = bucketRows.results.map(parseItemSummary);
    const byBucket = new Map<string, ItemSummary[]>(LIFE_BUCKETS.map((bucket) => [bucket, []]));
    for (const item of items) {
      if (item.bucket && byBucket.has(item.bucket)) {
        byBucket.get(item.bucket)!.push(item);
      }
    }
    const buckets: BucketGroup[] = LIFE_BUCKETS.map((bucket) => ({
      bucket,
      label: bucketLabel(bucket, null),
      dueAt: null,
      state: null,
      items: byBucket.get(bucket) ?? [],
    }));
    return { buckets, unlabeled: unlabeledRows.results.map(parseItemSummary) };
  }

  async searchItems(input: SearchItemsInput): Promise<ItemSummary[]> {
    const conditions = ["i.archived_at IS NULL"];
    const values: unknown[] = [];
    if (input.kind) {
      conditions.push("i.kind = ?");
      values.push(input.kind);
    }
    if (input.since) {
      conditions.push("i.timestamp >= ?");
      values.push(input.since);
    }
    if (input.course) {
      conditions.push("i.course = ?");
      values.push(normalizeCourseCode(input.course) ?? input.course.trim().toUpperCase());
    }

    const ftsQuery = buildFtsQuery(input.query);
    if (ftsQuery) {
      try {
        const rows = await this.db
          .prepare(
            `SELECT ${ITEM_BASE_COLUMNS}, ${ITEM_EXTRA_COLUMNS}
             FROM items_fts
             JOIN items i ON i.rowid = items_fts.rowid
             WHERE items_fts MATCH ? AND ${conditions.join(" AND ")}
             ORDER BY bm25(items_fts)
             LIMIT ?`,
          )
          .bind(ftsQuery, ...values, input.limit)
          .all<ItemSummaryRow>();
        if (rows.results.length > 0) {
          return rows.results.map(parseItemSummary);
        }
      } catch (error) {
        // A raw FTS5 syntax error must never surface to the caller — fall through
        // to the LIKE fallback below instead.
        console.error(JSON.stringify({ event: "search_items_fts_failed", message: error instanceof Error ? error.message : String(error) }));
      }
    }

    // LIKE fallback: also covers what FTS5's unicode61 tokenizer misses — it
    // merges a contiguous run of CJK characters into one token, so a
    // single/double-character CJK query (e.g. "作业") can MATCH nothing even
    // though the substring is right there in the title.
    const like = `%${escapeLike(input.query)}%`;
    const rows = await this.db
      .prepare(
        `SELECT ${ITEM_BASE_COLUMNS}, ${ITEM_EXTRA_COLUMNS}
         FROM items i
         WHERE (i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\') AND ${conditions.join(" AND ")}
         ORDER BY i.timestamp DESC
         LIMIT ?`,
      )
      .bind(like, like, ...values, input.limit)
      .all<ItemSummaryRow>();
    return rows.results.map(parseItemSummary);
  }

  async upcoming(input: UpcomingInput): Promise<ItemSummary[]> {
    const conditions = ["i.archived_at IS NULL"];
    const values: unknown[] = [];
    if (input.course) {
      conditions.push("i.course = ?");
      values.push(normalizeCourseCode(input.course) ?? input.course.trim().toUpperCase());
    }
    // A missed deadline stays visible for 90 days when includeOverdue is set,
    // matching the admin repository's overdue window order of magnitude.
    const windowStart = input.includeOverdue ? "julianday('now', '-90 days')" : "julianday('now')";
    const rows = await this.db
      .prepare(
        `SELECT ${ITEM_BASE_COLUMNS}, ${ITEM_STATE_COLUMN}, ${ITEM_STAFF_COLUMNS}, due.due_at AS due_at
         FROM items i
         JOIN (
           SELECT f.source, f.item_id, json_extract(f.data_json, '$.' || json_extract(b.value, '$.field')) AS due_at
           FROM facets f, json_each(f.capabilities_json) b
           WHERE json_extract(b.value, '$.primitive') = 'temporal'
         ) due ON due.source = i.source AND due.item_id = i.item_id
         WHERE ${conditions.join(" AND ")}
           AND julianday(due.due_at) BETWEEN ${windowStart} AND julianday('now', '+' || ? || ' days')
         ORDER BY julianday(due.due_at) ASC
         LIMIT 200`,
      )
      .bind(...values, input.days)
      .all<ItemSummaryRow>();
    return rows.results.map(parseItemSummary);
  }

  async getPlan(kind: PlanKind, subject: string): Promise<Plan | null> {
    const row = await this.db
      .prepare("SELECT kind, subject, content, updated_at FROM plans WHERE kind = ? AND subject = ?")
      .bind(kind, subject)
      .first<{ kind: PlanKind; subject: string; content: string; updated_at: string }>();
    return row ? { kind: row.kind, subject: row.subject, content: row.content, updatedAt: row.updated_at } : null;
  }

  async savePlan(kind: PlanKind, subject: string, content: string): Promise<Plan> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO plans (id, kind, subject, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, subject) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      )
      .bind(crypto.randomUUID(), kind, subject, content, now, now)
      .run();
    return { kind, subject, content, updatedAt: now };
  }

  async plannedSubjects(kind: PlanKind, subjects: string[]): Promise<Set<string>> {
    if (subjects.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .prepare(
        `SELECT p.subject FROM plans p JOIN json_each(?) s ON s.value = p.subject WHERE p.kind = ?`,
      )
      .bind(JSON.stringify(subjects), kind)
      .all<{ subject: string }>();
    return new Set(rows.results.map((row) => row.subject));
  }

  async labelItems(inputs: LabelItemInput[], by: LabeledBy): Promise<LabelItemsResult> {
    if (inputs.length === 0) {
      return { updated: 0, unknownItems: [], invalid: [] };
    }
    const knownCodes = new Set(await this.listKnownCourseCodes());
    const keysJson = JSON.stringify(inputs.map((input) => ({ source: input.source, itemId: input.itemId })));
    const existing = await this.db
      .prepare(
        `WITH requested AS (
           SELECT json_extract(value, '$.source') AS source, json_extract(value, '$.itemId') AS item_id
           FROM json_each(?)
         )
         SELECT i.source, i.item_id FROM requested r JOIN items i ON i.source = r.source AND i.item_id = r.item_id`,
      )
      .bind(keysJson)
      .all<{ source: string; item_id: string }>();
    const existingKeys = new Set(existing.results.map((row) => `${row.source}\u0000${row.item_id}`));

    const valid: Array<{ source: string; itemId: string; course: string | null; bucket: string; topic: string | null }> = [];
    const unknownItems: string[] = [];
    const invalid: LabelItemsResult["invalid"] = [];

    for (const input of inputs) {
      if (!existingKeys.has(`${input.source}\u0000${input.itemId}`)) {
        unknownItems.push(`${input.source}:${input.itemId}`);
        continue;
      }
      const parsed = parseBucketShape(input.bucket, knownCodes);
      if (!parsed) {
        invalid.push({ source: input.source, itemId: input.itemId, bucket: input.bucket, reason: "Not one of the five bucket shapes, or the course code is unknown." });
        continue;
      }
      valid.push({ source: input.source, itemId: input.itemId, course: parsed.course, bucket: input.bucket, topic: input.topic ?? null });
    }

    if (valid.length > 0) {
      await this.db.batch(
        valid.map((item) =>
          this.db
            .prepare("UPDATE items SET course = ?, bucket = ?, topic = ?, labeled_by = ? WHERE source = ? AND item_id = ?")
            .bind(item.course, item.bucket, item.topic, by, item.source, item.itemId),
        ),
      );
    }
    return { updated: valid.length, unknownItems, invalid };
  }

  async listKnownCourseCodes(): Promise<string[]> {
    const rows = await this.db.prepare(`SELECT DISTINCT json_extract(data_json, '$.code') AS code FROM facets WHERE type = 'course-identity'`).all<{ code: string | null }>();
    const codes = new Set<string>();
    for (const row of rows.results) {
      const code = row.code ? normalizeCourseCode(row.code) : null;
      if (code) {
        codes.add(code);
      }
    }
    return [...codes].sort();
  }

  async unlabeledItems(limit: number): Promise<ItemSummary[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${ITEM_BASE_COLUMNS}, ${ITEM_EXTRA_COLUMNS}
         FROM items i
         WHERE i.archived_at IS NULL AND i.bucket IS NULL
         ORDER BY i.timestamp DESC
         LIMIT ?`,
      )
      .bind(limit)
      .all<ItemSummaryRow>();
    return rows.results.map(parseItemSummary);
  }

  async sourceStatus(): Promise<{ sources: RepoSourceStatus[]; latestCursor: string }> {
    const [countRows, cursorRow, lastCycleRow] = await Promise.all([
      this.db.prepare("SELECT source, COUNT(*) AS n FROM items WHERE archived_at IS NULL GROUP BY source").all<{ source: string; n: number }>(),
      this.db.prepare("SELECT MAX(seq) AS latest FROM changes").first<{ latest: number | null }>(),
      this.db.prepare("SELECT value_json FROM settings WHERE key = 'last_cycle'").first<{ value_json: string }>(),
    ]);
    const counts = new Map(countRows.results.map((row) => [row.source, row.n]));
    const cycle: StoredCycle = lastCycleRow ? JSON.parse(lastCycleRow.value_json) : {};
    const bySource = new Map((cycle.sources ?? []).map((source) => [source.plugin, source]));
    const ids = new Set([...counts.keys(), ...bySource.keys()]);
    const sources = [...ids]
      .sort()
      .map((id) => {
        const sync = bySource.get(id);
        return {
          id,
          label: sourceLabel(id),
          lastSyncAt: sync?.lastSyncAt ?? null,
          lastError: sync?.lastError ?? null,
          items: counts.get(id) ?? 0,
        };
      });
    return { sources, latestCursor: String(cursorRow?.latest ?? 0) };
  }
}
