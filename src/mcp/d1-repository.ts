import { CORRECTIONS_DOMAIN, recordCorrection } from "../corrections";
import { D1ItemStore } from "../kernel/d1-item-store";
import { STAFF_ROLES } from "../kernel/staff-roles";
import type { ItemEvent, JsonValue, StoredItem } from "../kernel/types";
import { D1MemoryStore, type MemoryNote } from "../memory";
import { D1ManifestStore, type StoredPluginManifest } from "../plugins/declarative/store";
import type {
  CourseAssessment,
  CourseEmailMention,
  CourseOverview,
  CourseStaffPost,
  CourseSummary,
  Plan,
  PlanKind,
  RememberResult,
  SearchItemsQuery,
  StaffPostQuery,
} from "./types";
import type {
  EventQuery,
  ItemQuery,
  ItemRelation,
  LinkItemsInput,
  McpRepository,
  UpcomingItem,
  UpcomingQuery,
} from "./server";

const DEFAULT_STAFF_POST_WINDOW_DAYS = 14;

interface CourseIdentityRow {
  source: string;
  item_id: string;
  title: string;
  code: string | null;
  platform: string | null;
  status: string | null;
}

interface CourseAssessmentRow {
  source: string;
  item_id: string;
  title: string;
  url: string | null;
  due_at: string | null;
  status: string | null;
}

interface StaffPostRow {
  source: string;
  item_id: string;
  title: string;
  url: string | null;
  timestamp: string;
  author_role: string | null;
  pin_status: string | null;
  thread_type: string | null;
}

interface EmailMentionRow {
  source: string;
  item_id: string;
  title: string;
  url: string | null;
  timestamp: string;
}

interface PlanRow {
  id: string;
  kind: PlanKind;
  subject: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface ItemKeyRow {
  source: string;
  item_id: string;
}

interface UpcomingRow {
  source: string;
  item_id: string;
  title: string;
  url: string | null;
  facet_type: string;
  capability: string;
  due_at: string;
}

// Events v2 (ADR-0036): one row per entry in `changes`. No item id / capability
// row-id concept survives here — `seq` is the cursor.
interface ChangeRow {
  seq: number;
  type: ItemEvent["type"];
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
}

interface RelationRow {
  id: string;
  type: string;
  from_source: string;
  from_item_id: string;
  to_source: string;
  to_item_id: string;
  metadata_json: string;
  confirmed_at: string;
}

export class D1McpRepository implements McpRepository {
  private readonly items: D1ItemStore;
  private readonly manifests: D1ManifestStore;
  private readonly memory: D1MemoryStore;

  constructor(private readonly db: D1Database) {
    this.items = new D1ItemStore(db);
    this.manifests = new D1ManifestStore(db);
    this.memory = new D1MemoryStore(db);
  }

  find(source: string, itemId: string): Promise<StoredItem | null> {
    return this.items.find(source, itemId);
  }

  findMany(keys: Array<{ source: string; itemId: string }>): Promise<StoredItem[]> {
    return this.items.findMany(keys);
  }

  async listItems(query: ItemQuery): Promise<StoredItem[]> {
    const conditions = ["archived_at IS NULL"];
    const values: Array<string | number> = [];
    if (query.source) {
      conditions.push("source = ?");
      values.push(query.source);
    }
    if (query.kind) {
      conditions.push("kind = ?");
      values.push(query.kind);
    }
    values.push(query.limit);
    const rows = await this.db
      .prepare(
        `SELECT source, item_id
         FROM items
         WHERE ${conditions.join(" AND ")}
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .bind(...values)
      .all<ItemKeyRow>();

    return this.items.findMany(rows.results.map((row) => ({ source: row.source, itemId: row.item_id })));
  }

  async listUpcoming(query: UpcomingQuery): Promise<UpcomingItem[]> {
    // With includeOverdue the window opens 30 days back so a missed deadline is
    // still visible; otherwise it starts at now.
    const windowStart = query.includeOverdue ? "julianday('now', '-30 days')" : "julianday('now')";
    const rows = await this.db
      .prepare(
        `SELECT
           i.source,
           i.item_id,
           i.title,
           i.url,
           f.type AS facet_type,
           json_extract(binding.value, '$.name') AS capability,
           json_extract(
             f.data_json,
             '$.' || json_extract(binding.value, '$.field')
           ) AS due_at
         FROM items i
         JOIN facets f ON f.source = i.source AND f.item_id = i.item_id
         JOIN json_each(f.capabilities_json) binding
         WHERE i.archived_at IS NULL
           AND json_extract(binding.value, '$.primitive') = 'temporal'
           AND julianday(due_at) BETWEEN ${windowStart} AND julianday('now', '+' || ? || ' days')
         ORDER BY julianday(due_at), i.title
         LIMIT ?`,
      )
      .bind(query.days, query.limit)
      .all<UpcomingRow>();
    return rows.results.map((row) => ({
      source: row.source,
      itemId: row.item_id,
      title: row.title,
      dueAt: row.due_at,
      ...(row.url ? { url: row.url } : {}),
      facetType: row.facet_type,
      capability: row.capability,
    }));
  }

  async listEvents(query: EventQuery): Promise<ItemEvent[]> {
    const rows = query.since
      ? await this.db
          .prepare(
            `SELECT * FROM changes
             WHERE created_at >= ?
             ORDER BY seq DESC
             LIMIT ?`,
          )
          .bind(query.since, query.limit)
          .all<ChangeRow>()
      : await this.db
          .prepare("SELECT * FROM changes ORDER BY seq DESC LIMIT ?")
          .bind(query.limit)
          .all<ChangeRow>();
    return rows.results.map(parseEvent);
  }

  // Oldest-first window, ordered by the `seq` cursor so a caller can chain
  // "since the last seq I saw" across cycles without gaps or repeats.
  async listEventsAscending(since: string, limit: number): Promise<ItemEvent[]> {
    const rows = await this.db
      .prepare("SELECT * FROM changes WHERE created_at >= ? ORDER BY seq ASC LIMIT ?")
      .bind(since, limit)
      .all<ChangeRow>();
    return rows.results.map(parseEvent);
  }

  async listRelations(type?: string): Promise<ItemRelation[]> {
    const rows = type
      ? await this.db
          .prepare("SELECT * FROM relations WHERE type = ? ORDER BY confirmed_at DESC")
          .bind(type)
          .all<RelationRow>()
      : await this.db.prepare("SELECT * FROM relations ORDER BY confirmed_at DESC").all<RelationRow>();
    return rows.results.map(parseRelation);
  }

  async linkItems(input: LinkItemsInput): Promise<ItemRelation> {
    const normalized = normalizeRelation(input);
    const [from, to] = await Promise.all([
      this.find(normalized.fromSource, normalized.fromItemId),
      this.find(normalized.toSource, normalized.toItemId),
    ]);
    if (!from || !to) {
      const missing = [
        ...(from ? [] : [`${normalized.fromSource}/${normalized.fromItemId}`]),
        ...(to ? [] : [`${normalized.toSource}/${normalized.toItemId}`]),
      ];
      throw new Error(`Cannot link: item${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}. Check source and itemId with list_items.`);
    }
    const confirmedAt = new Date().toISOString();
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO relations (
           id, type, from_source, from_item_id, to_source, to_item_id, metadata_json, confirmed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (type, from_source, from_item_id, to_source, to_item_id) DO UPDATE SET
           metadata_json = excluded.metadata_json,
           confirmed_at = excluded.confirmed_at`,
      )
      .bind(
        id,
        normalized.type,
        normalized.fromSource,
        normalized.fromItemId,
        normalized.toSource,
        normalized.toItemId,
        JSON.stringify(normalized.metadata),
        confirmedAt,
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT * FROM relations
         WHERE type = ? AND from_source = ? AND from_item_id = ? AND to_source = ? AND to_item_id = ?`,
      )
      .bind(
        normalized.type,
        normalized.fromSource,
        normalized.fromItemId,
        normalized.toSource,
        normalized.toItemId,
      )
      .first<RelationRow>();
    if (!row) {
      throw new Error("Relation was not persisted.");
    }
    return parseRelation(row);
  }

  listPluginManifests(): Promise<StoredPluginManifest[]> {
    return this.manifests.list();
  }

  putPluginManifest(manifest: unknown, enabled: boolean): Promise<StoredPluginManifest> {
    return this.manifests.upsert(manifest, enabled);
  }

  // ADR-0034: the only memory read left in the admin surface. Corrections are
  // stored verbatim (zero-LLM) by `remember`; this just lets an operator see
  // what has been recorded.
  listCorrections(): Promise<MemoryNote> {
    return this.memory.get(CORRECTIONS_DOMAIN);
  }

  async getSyncStatus(): Promise<JsonValue | null> {
    const row = await this.db
      .prepare("SELECT value_json FROM settings WHERE key = 'last_cycle'")
      .first<{ value_json: string }>();
    return row ? (JSON.parse(row.value_json) as JsonValue) : null;
  }

  async listCourses(): Promise<CourseSummary[]> {
    const rows = await this.db
      .prepare(
        `SELECT i.source, i.item_id, i.title,
           json_extract(f.data_json, '$.code') as code,
           json_extract(f.data_json, '$.platform') as platform,
           json_extract(f.data_json, '$.status') as status
         FROM items i
         JOIN facets f ON f.source = i.source AND f.item_id = i.item_id AND f.type = 'course-identity'
         WHERE i.archived_at IS NULL
         ORDER BY i.title
         LIMIT 100`,
      )
      .all<CourseIdentityRow>();
    return rows.results.map(parseCourseSummary);
  }

  async getCourseOverview(course: string): Promise<CourseOverview> {
    const matches = await this.resolveCourseMatches(course);
    const code = normalizeCourseCode(course);

    const moodleMatches = matches.filter((match) => match.source === "campus-moodle");
    const edMatches = matches.filter((match) => match.source === "campus-ed");
    const since = new Date(Date.now() - DEFAULT_STAFF_POST_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString();

    const [assessments, staffPosts, emailMentions, ontrack] = await Promise.all([
      Promise.all(moodleMatches.map((match) => this.courseAssessments(match.source, match.itemId))).then((lists) =>
        lists.flat().sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? "")),
      ),
      Promise.all(edMatches.map((match) => this.courseStaffPosts(match.source, match.itemId, since, 20))).then(
        (lists) => lists.flat().sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
      ),
      this.courseEmailMentions(code, 20),
      this.sourceExists("%ontrack%"),
    ]);

    return {
      query: course,
      identity:
        matches.length === 0
          ? null
          : { code, name: matches[0]!.name, platforms: [...new Set(matches.map((match) => match.source))] },
      assessments,
      staffPosts,
      emailMentions,
      sources: {
        moodle: moodleMatches.length > 0,
        ed: edMatches.length > 0,
        ontrack,
        email: emailMentions.length > 0,
      },
    };
  }

  async searchItems(query: SearchItemsQuery): Promise<StoredItem[]> {
    // LIKE, not FTS5 (ADR-0036 leaves the FTS switch to door v2 work) — items_fts
    // exists from migration 0012 onward but nothing here reads it yet.
    const conditions = ["archived_at IS NULL", "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')"];
    const like = `%${escapeLike(query.query)}%`;
    const values: Array<string | number> = [like, like];
    if (query.kind) {
      conditions.push("kind = ?");
      values.push(query.kind);
    }
    if (query.since) {
      conditions.push("timestamp >= ?");
      values.push(query.since);
    }
    if (query.course) {
      const matches = await this.resolveCourseMatches(query.course);
      const code = normalizeCourseCode(query.course);
      const membershipClauses = matches.map(
        () =>
          `EXISTS (SELECT 1 FROM facets cm WHERE cm.source = items.source AND cm.item_id = items.item_id
             AND cm.type = 'course-membership' AND items.source = ? AND json_extract(cm.data_json, '$.course') = ?)`,
      );
      const mentionClause = `EXISTS (
        SELECT 1 FROM facets men, json_each(men.data_json, '$.codes') c
        WHERE men.source = items.source AND men.item_id = items.item_id
          AND men.type = 'course-mention' AND upper(c.value) = ?
      )`;
      conditions.push(`(${[...membershipClauses, mentionClause].join(" OR ")})`);
      for (const match of matches) {
        values.push(match.source, match.itemId);
      }
      values.push(code);
    }
    values.push(query.limit);
    const rows = await this.db
      .prepare(
        `SELECT source, item_id FROM items WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT ?`,
      )
      .bind(...values)
      .all<ItemKeyRow>();
    return this.items.findMany(rows.results.map((row) => ({ source: row.source, itemId: row.item_id })));
  }

  async listStaffPosts(query: StaffPostQuery): Promise<CourseStaffPost[]> {
    const since = query.since ?? new Date(Date.now() - DEFAULT_STAFF_POST_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    if (!query.course) {
      return this.staffPostsBySource(null, null, since, query.limit);
    }
    const matches = (await this.resolveCourseMatches(query.course)).filter((match) => match.source === "campus-ed");
    const lists = await Promise.all(
      matches.map((match) => this.courseStaffPosts(match.source, match.itemId, since, query.limit)),
    );
    return lists
      .flat()
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, query.limit);
  }

  async getPlan(kind: PlanKind, subject: string): Promise<Plan | null> {
    const row = await this.db
      .prepare("SELECT * FROM plans WHERE kind = ? AND subject = ?")
      .bind(kind, subject)
      .first<PlanRow>();
    return row ? parsePlan(row) : null;
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
    const row = await this.db
      .prepare("SELECT * FROM plans WHERE kind = ? AND subject = ?")
      .bind(kind, subject)
      .first<PlanRow>();
    if (!row) {
      throw new Error("Plan was not persisted.");
    }
    return parsePlan(row);
  }

  async remember(text: string): Promise<RememberResult> {
    return recordCorrection(this.memory, text);
  }

  // Matches a unit code (e.g. "FIT2004") or a raw item id against every
  // known course-identity facet. A course can legitimately match more than
  // one row: the same unit usually exists as both a Moodle course and an Ed
  // course, each with its own source-local item id.
  private async resolveCourseMatches(courseParam: string): Promise<CourseIdentityMatch[]> {
    const trimmed = courseParam.trim();
    const code = normalizeCourseCode(trimmed);
    const rows = await this.db
      .prepare(
        `SELECT i.source, i.item_id, i.title,
           json_extract(f.data_json, '$.code') as code,
           json_extract(f.data_json, '$.platform') as platform,
           json_extract(f.data_json, '$.status') as status
         FROM items i
         JOIN facets f ON f.source = i.source AND f.item_id = i.item_id AND f.type = 'course-identity'
         WHERE i.archived_at IS NULL
           AND (i.item_id = ? OR upper(json_extract(f.data_json, '$.code')) LIKE ? || '%')
         ORDER BY i.title`,
      )
      .bind(trimmed, code)
      .all<CourseIdentityRow>();
    return rows.results.map((row) => ({ source: row.source, itemId: row.item_id, name: row.title }));
  }

  private async courseAssessments(source: string, courseItemId: string): Promise<CourseAssessment[]> {
    const rows = await this.db
      .prepare(
        `SELECT i.source, i.item_id, i.title, i.url,
           json_extract(d.data_json, '$.dueAt') as due_at,
           json_extract(s.data_json, '$.status') as status
         FROM items i
         JOIN facets m ON m.source = i.source AND m.item_id = i.item_id AND m.type = 'course-membership'
         LEFT JOIN facets d ON d.source = i.source AND d.item_id = i.item_id AND d.type = 'deadline'
         LEFT JOIN facets s ON s.source = i.source AND s.item_id = i.item_id AND s.type = 'submission'
         WHERE i.archived_at IS NULL
           AND i.source = ? AND i.kind = 'assessment'
           AND json_extract(m.data_json, '$.course') = ?
         ORDER BY due_at
         LIMIT 30`,
      )
      .bind(source, courseItemId)
      .all<CourseAssessmentRow>();
    return rows.results.map((row) => ({
      source: row.source,
      itemId: row.item_id,
      title: row.title,
      ...(row.url ? { url: row.url } : {}),
      dueAt: row.due_at,
      status: row.status,
    }));
  }

  private async courseStaffPosts(
    source: string,
    courseItemId: string,
    since: string,
    limit: number,
  ): Promise<CourseStaffPost[]> {
    return this.staffPostsBySource(source, courseItemId, since, limit);
  }

  private async staffPostsBySource(
    source: string | null,
    courseItemId: string | null,
    since: string,
    limit: number,
  ): Promise<CourseStaffPost[]> {
    const conditions = ["i.archived_at IS NULL", "i.source = 'campus-ed'", "i.kind = 'thread'", "i.timestamp >= ?"];
    const values: Array<string | number> = [since];
    let membershipJoin = "";
    if (source && courseItemId) {
      membershipJoin =
        "JOIN facets m ON m.source = i.source AND m.item_id = i.item_id AND m.type = 'course-membership'";
      conditions.push("json_extract(m.data_json, '$.course') = ?");
      values.push(courseItemId);
    }
    values.push(limit * 4); // over-fetch: staff filtering happens in JS below.
    const rows = await this.db
      .prepare(
        `SELECT i.source, i.item_id, i.title, i.url, i.timestamp,
           json_extract(a.data_json, '$.authorRole') as author_role,
           json_extract(disc.data_json, '$.pinStatus') as pin_status,
           json_extract(i.raw_json, '$.type') as thread_type
         FROM items i
         ${membershipJoin}
         LEFT JOIN facets a ON a.source = i.source AND a.item_id = i.item_id AND a.type = 'author'
         LEFT JOIN facets disc ON disc.source = i.source AND disc.item_id = i.item_id AND disc.type = 'discussion-state'
         WHERE ${conditions.join(" AND ")}
         ORDER BY i.timestamp DESC
         LIMIT ?`,
      )
      .bind(...values)
      .all<StaffPostRow>();
    return rows.results
      .filter(isStaffPostRow)
      .slice(0, limit)
      .map((row) => ({
        source: row.source,
        itemId: row.item_id,
        title: row.title,
        ...(row.url ? { url: row.url } : {}),
        timestamp: row.timestamp,
      }));
  }

  private async courseEmailMentions(code: string, limit: number): Promise<CourseEmailMention[]> {
    const rows = await this.db
      .prepare(
        `SELECT i.source, i.item_id, i.title, i.url, i.timestamp
         FROM items i
         JOIN facets f ON f.source = i.source AND f.item_id = i.item_id AND f.type = 'course-mention'
         JOIN json_each(f.data_json, '$.codes') codes ON upper(codes.value) = ?
         WHERE i.archived_at IS NULL
         ORDER BY i.timestamp DESC
         LIMIT ?`,
      )
      .bind(code, limit)
      .all<EmailMentionRow>();
    return rows.results.map((row) => ({
      source: row.source,
      itemId: row.item_id,
      title: row.title,
      ...(row.url ? { url: row.url } : {}),
      timestamp: row.timestamp,
    }));
  }

  private async sourceExists(likePattern: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT 1 FROM items WHERE source LIKE ? LIMIT 1").bind(likePattern).first();
    return row !== null;
  }
}

function parseEvent(row: ChangeRow): ItemEvent {
  return {
    type: row.type,
    source: row.source,
    itemId: row.item_id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    topic: row.topic,
    field: row.field,
    before: row.before_json ? (JSON.parse(row.before_json) as JsonValue) : null,
    after: row.after_json ? (JSON.parse(row.after_json) as JsonValue) : null,
    createdAt: row.created_at,
  };
}

function parseRelation(row: RelationRow): ItemRelation {
  return {
    id: row.id,
    type: row.type,
    fromSource: row.from_source,
    fromItemId: row.from_item_id,
    toSource: row.to_source,
    toItemId: row.to_item_id,
    metadata: JSON.parse(row.metadata_json) as JsonValue,
    confirmedAt: row.confirmed_at,
  };
}

function normalizeRelation(input: LinkItemsInput): LinkItemsInput {
  if (input.type !== "same-course") {
    return input;
  }
  const from = `${input.fromSource}:${input.fromItemId}`;
  const to = `${input.toSource}:${input.toItemId}`;
  if (from <= to) {
    return input;
  }
  return {
    ...input,
    fromSource: input.toSource,
    fromItemId: input.toItemId,
    toSource: input.fromSource,
    toItemId: input.fromItemId,
  };
}

interface CourseIdentityMatch {
  source: string;
  itemId: string;
  name: string;
}

function parseCourseSummary(row: CourseIdentityRow): CourseSummary {
  return {
    source: row.source,
    itemId: row.item_id,
    code: row.code ?? "",
    name: row.title,
    platform: row.platform ?? row.source,
    status: row.status ?? "unknown",
  };
}

function parsePlan(row: PlanRow): Plan {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ADR-0031: a thread counts as staff-authored when the Ed plugin resolved a
// staff-shaped author role, or the thread is a platform announcement, or it
// is pinned. Filtered here in JS (not SQL) because the row already carries
// every field needed and keeping the staff definition in one readable place
// beats re-deriving it with a harder-to-read SQL boolean expression.
function isStaffPostRow(row: StaffPostRow): boolean {
  const role = row.author_role?.toLowerCase();
  return (role !== undefined && STAFF_ROLES.has(role)) || row.thread_type === "announcement" || row.pin_status === "pinned";
}

// Extracts the leading unit-code token (e.g. "FIT2004") from input like
// "fit2004", "FIT2004 S1 2026", or a bare course title, uppercased for a
// case-insensitive LIKE/equality match against stored course-identity codes
// and course-mention codes alike.
function normalizeCourseCode(input: string): string {
  const upper = input.trim().toUpperCase();
  return upper.match(/^[A-Z]{2,5}\d{3,4}/)?.[0] ?? upper;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
