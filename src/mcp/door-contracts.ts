// Door v2 wire contracts (ADR-0035, ADR-0036, ADR-0037).
//
// Every door tool returns BOTH a complete text rendering (content[0].text, the
// fallback for clients that do not render widgets) and `structuredContent` typed
// by one of the interfaces below. Widgets read only `structuredContent`; the text
// never depends on a widget. Changing a shape here is a breaking change for the
// widgets in src/widgets and for any routine that parses results.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// --- Buckets ---------------------------------------------------------------

// "course/<CODE>/<assignment-slug>" | "course/<CODE>/general"
// | "life/events" | "life/admin" | "life/other"
export type Bucket = string;
export type LabeledBy = "structure" | "triage" | "client";
export const LIFE_BUCKETS = ["life/events", "life/admin", "life/other"] as const;

// --- Items -----------------------------------------------------------------

// The projection every door tool uses for an Item. Never carries `raw`; `body` is
// only present where the tool says so (course/search clip it to `snippet`).
export interface ItemSummary {
  source: string; // "campus-moodle" | "campus-ed" | "campus-canvas" | "gmail" | manifest id
  itemId: string;
  kind: string; // "course" | "assessment" | "thread" | "announcement" | "email" | …
  title: string;
  url: string | null;
  timestamp: string; // ISO; creation/post time
  dueAt: string | null; // ISO when the item has a temporal deadline capability
  state: string | null; // submission / answer status when present
  course: string | null; // normalised code, e.g. "FIT3175"
  bucket: Bucket | null;
  topic: string | null;
  labeledBy: LabeledBy | null;
  unlabeled: boolean; // true when bucket is null — the client decides on the spot
  staff: boolean; // authored by teaching staff
  snippet: string | null; // first ~240 chars of body, whitespace-collapsed
}

// --- changes_since -----------------------------------------------------------

export type ChangeType =
  | "item.added"
  | "item.archived"
  | "item.restored"
  | "deadline.changed"
  | "state.changed"
  | "grade.changed"
  | "content.changed"
  | "notice.posted";

export interface ChangeEvent {
  cursor: string; // monotonic integer as a string; pass back as `cursor`
  type: ChangeType | string; // legacy v1 rows keep their old type names
  at: string; // ISO
  source: string;
  itemId: string;
  kind: string;
  title: string;
  url: string | null;
  course: string | null; // the item's current course (labels improve over time)
  bucket: Bucket | null;
  topic: string | null;
  field: string | null; // the capability/field that changed, when relevant
  before: JsonValue | null; // full values, never clipped
  after: JsonValue | null;
}

export interface ChangesPage {
  events: ChangeEvent[]; // ascending by cursor
  nextCursor: string; // equals the input cursor when nothing is new
  hasMore: boolean;
  counts: Partial<Record<ChangeType, number>>; // over `events` only
}

// --- course(code) / life() -----------------------------------------------------

export interface CourseMatch {
  code: string;
  term: string | null;
  title: string;
  source: string;
  itemId: string;
  url: string | null;
}

export interface BucketGroup {
  bucket: Bucket;
  label: string; // human label: "Assignment 2", "General", "Events"
  dueAt: string | null; // the owning assessment's deadline, for assignment buckets
  state: string | null; // the owning assessment's submission state
  items: ItemSummary[]; // newest first; assessments first within an assignment bucket
}

export interface CourseView {
  query: string;
  code: string | null; // null when nothing matched
  title: string | null;
  term: string | null;
  ambiguous: boolean; // several offerings matched; `matches` lists them all
  matches: CourseMatch[];
  sources: string[]; // sources that know this course
  buckets: BucketGroup[]; // assignment buckets by dueAt, then general
  unlabeled: ItemSummary[]; // course-related items without a bucket yet
}

export interface LifeView {
  buckets: BucketGroup[]; // always the three life buckets, possibly empty
  unlabeled: ItemSummary[]; // non-course items nobody has labelled yet (newest 50)
}

// --- search_items / upcoming ----------------------------------------------------

export interface ItemList {
  query: string | null;
  items: ItemSummary[];
}

// --- briefs -----------------------------------------------------------------

export interface Brief {
  id: string;
  kind: string; // "digest" | "weekly-plan" | "assignment-plan" | "forum-brief" | "triage" | routine-defined slug
  subject: string;
  title: string;
  body: string; // markdown
  createdAt: string;
  readAt: string | null;
}

export interface BriefList {
  briefs: Brief[];
  unread: number; // total unread, not just this page
}

// --- plans ------------------------------------------------------------------

// `content` is markdown. Checklist lines are GitHub task items: "- [ ] text" /
// "- [x] text". The plan widget toggles those and calls save_plan with the whole
// updated markdown; nothing else in the document is touched.
export interface Plan {
  kind: "weekly" | "assignment";
  subject: string; // ISO week "2026-W39" or an assignment key "campus-moodle:assessment:123"
  content: string;
  updatedAt: string;
}

export interface PlanResult {
  plan: Plan | null;
}

// --- status -----------------------------------------------------------------

export interface SourceStatus {
  id: string; // plugin id
  label: string; // "Moodle", "Ed", "Canvas", "Gmail", manifest name
  configured: boolean;
  lastSyncAt: string | null;
  lastError: string | null; // stable error code/message, never a secret
  items: number; // active item count
}

export interface StatusView {
  sources: SourceStatus[];
  scheduler: { running: boolean; lastCycleAt: string | null };
  latestCursor: string;
  timezone: string; // IANA, e.g. "Australia/Melbourne"
}

// --- run_playbook -------------------------------------------------------------

export type PlaybookName = "weekly-plan" | "decompose-assignment" | "forum-brief" | "triage";

export interface PlaybookRun {
  name: PlaybookName;
  instructions: string; // the playbook markdown, same text as prompts/get
  data: Record<string, JsonValue>; // what the procedure needs, pre-fetched
  corrections: string[]; // the user's verbatim `remember` notes, newest last
}

// --- widgets -----------------------------------------------------------------

export const WIDGET_URIS = {
  briefCard: "ui://unicorn/brief-card",
  courseView: "ui://unicorn/course-view",
  changesFeed: "ui://unicorn/changes-feed",
  planChecklist: "ui://unicorn/plan-checklist",
  deadlineTimeline: "ui://unicorn/deadline-timeline",
  connectionStatus: "ui://unicorn/connection-status",
} as const;

// Which tool renders which widget, and with which structuredContent shape:
//   get_briefs     → briefCard        (BriefList)       actions: ack_briefs({ ids })
//   course         → courseView       (CourseView)      actions: none
//   changes_since  → changesFeed      (ChangesPage)     actions: none
//   get_plan       → planChecklist    (PlanResult)      actions: save_plan({ kind, subject, content })
//   upcoming       → deadlineTimeline (ItemList)        actions: none
//   search_items   → deadlineTimeline (ItemList)        actions: none
//   status         → connectionStatus (StatusView)      actions: none
