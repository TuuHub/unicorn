import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ItemEvent, JsonValue, StoredItem } from "../kernel/types";
import type { MemoryNote } from "../memory";
import type { EventQuery, UpcomingItem, UpcomingQuery } from "../mcp/server";

// ADR-0031's tool set, all read-only on sources. Every tool result is a
// projection (clipped bodies, bounded lists) except get_item, which is the
// one place a playbook can read a full body.

export type PlanKind = "weekly" | "assignment";

export interface Plan {
  id: string;
  kind: PlanKind;
  subject: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface CourseSummary {
  source: string;
  itemId: string;
  code: string;
  name: string;
  platform: string;
  status: string;
}

export interface CourseAssessment {
  source: string;
  itemId: string;
  title: string;
  url?: string;
  dueAt: string | null;
  status: string | null;
}

export interface CourseStaffPost {
  source: string;
  itemId: string;
  title: string;
  url?: string;
  timestamp: string;
}

export interface CourseEmailMention {
  source: string;
  itemId: string;
  title: string;
  url?: string;
  timestamp: string;
}

export interface CourseOverview {
  query: string;
  identity: { code: string; name: string; platforms: string[] } | null;
  assessments: CourseAssessment[];
  staffPosts: CourseStaffPost[];
  emailMentions: CourseEmailMention[];
  sources: { moodle: boolean; ed: boolean; ontrack: boolean; email: boolean };
}

export interface SearchItemsQuery {
  query: string;
  kind?: string;
  course?: string;
  since?: string;
  limit: number;
}

export interface StaffPostQuery {
  course?: string;
  since?: string;
  limit: number;
}

export type RememberResult = "saved" | "duplicate" | "empty";

export interface AgentToolRepository {
  listCourses(): Promise<CourseSummary[]>;
  getCourseOverview(course: string): Promise<CourseOverview>;
  searchItems(query: SearchItemsQuery): Promise<StoredItem[]>;
  find(source: string, itemId: string): Promise<StoredItem | null>;
  listUpcoming(query: UpcomingQuery): Promise<UpcomingItem[]>;
  listEvents(query: EventQuery): Promise<ItemEvent[]>;
  listStaffPosts(query: StaffPostQuery): Promise<CourseStaffPost[]>;
  listMemory(): Promise<MemoryNote[]>;
  getSyncStatus(): Promise<JsonValue | null>;
  getPlan(kind: PlanKind, subject: string): Promise<Plan | null>;
  savePlan(kind: PlanKind, subject: string, content: string): Promise<Plan>;
  remember(text: string): Promise<RememberResult>;
}

export function createResidentTools(repository: AgentToolRepository): AgentTool[] {
  return [
    defineTool({
      name: "list_courses",
      label: "List courses",
      description: "List every enrolled unit known to Unicorn, across every connected source. Use this first to learn valid unit codes before calling get_course_overview.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => toolResult(await repository.listCourses()),
    }),
    defineTool({
      name: "get_course_overview",
      label: "Get course overview",
      description: "Read one unit's assessments (with due date and submission status), recent staff posts, and email mentions in one call. Accepts a unit code (e.g. FIT2004) or a course item id. Check the returned `sources` booleans before claiming a source has nothing — a false value means that source is not connected for this unit, not that nothing is due.",
      parameters: Type.Object({
        course: Type.String({ minLength: 1, maxLength: 100 }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => toolResult(await repository.getCourseOverview(params.course)),
    }),
    defineTool({
      name: "search_items",
      label: "Search items",
      description: "Search normalized item titles and bodies for a keyword. Use this to find emails, threads, or assessments that get_course_overview did not surface, e.g. schedule-change keywords.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 200 }),
        kind: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        course: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        since: Type.Optional(Type.String({ minLength: 10, maxLength: 40 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const items = await repository.searchItems({
          query: params.query,
          ...(params.kind ? { kind: params.kind } : {}),
          ...(params.course ? { course: params.course } : {}),
          ...(params.since ? { since: params.since } : {}),
          limit: params.limit ?? 10,
        });
        return toolResult(items.map(projectItemSummary));
      },
    }),
    defineTool({
      name: "get_item",
      label: "Get item",
      description: "Read one specific normalized item in full, including its uncapped body, after identifying its source and item id.",
      parameters: Type.Object({
        source: Type.String({ minLength: 1, maxLength: 100 }),
        itemId: Type.String({ minLength: 1, maxLength: 200 }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        toolResult(projectFullItem(await repository.find(params.source, stripSourcePrefix(params.source, params.itemId)))),
    }),
    defineTool({
      name: "list_upcoming",
      label: "List upcoming",
      description: "List upcoming or recently overdue deadlines from Unicorn's normalized world state.",
      parameters: Type.Object({
        days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
        includeOverdue: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        toolResult(
          await repository.listUpcoming({
            days: params.days ?? 14,
            includeOverdue: params.includeOverdue ?? false,
            limit: params.limit ?? 10,
          }),
        ),
    }),
    defineTool({
      name: "list_changes",
      label: "List changes",
      description: "List recent item and capability changes, newest first.",
      parameters: Type.Object({
        since: Type.Optional(Type.String({ minLength: 10, maxLength: 40 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const events = await repository.listEvents({
          ...(params.since ? { since: params.since } : {}),
          limit: params.limit ?? 10,
        });
        return toolResult(
          events.map(({ id: _id, before, after, ...event }) => ({
            ...event,
            ...(before !== undefined ? { before: clipJson(before) } : {}),
            ...(after !== undefined ? { after: clipJson(after) } : {}),
          })),
        );
      },
    }),
    defineTool({
      name: "list_staff_posts",
      label: "List staff posts",
      description: "List Ed threads authored by teaching staff, or announcement/pinned threads, newest first. Optionally scope to one unit code and a since timestamp.",
      parameters: Type.Object({
        course: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        since: Type.Optional(Type.String({ minLength: 10, maxLength: 40 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        toolResult(
          await repository.listStaffPosts({
            ...(params.course ? { course: params.course } : {}),
            ...(params.since ? { since: params.since } : {}),
            limit: params.limit ?? 10,
          }),
        ),
    }),
    defineTool({
      name: "list_memory",
      label: "List memory",
      description: "Read Unicorn's remembered preferences and correction notes.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        const notes = await repository.listMemory();
        return toolResult(
          notes.map((note) => ({
            domain: note.domain,
            updatedAt: note.updatedAt,
            content: clipText(note.content, 1_000),
            contentTruncated: note.content.length > 1_000,
          })),
        );
      },
    }),
    defineTool({
      name: "get_sync_status",
      label: "Get sync status",
      description: "Read the latest ingestion cycle status before explaining stale or missing data.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => toolResult((await repository.getSyncStatus()) ?? { status: "never_run" }),
    }),
    defineTool({
      name: "get_plan",
      label: "Get plan",
      description: "Read a previously saved plan (a weekly plan or an assignment decomposition) if one exists.",
      parameters: Type.Object({
        kind: Type.Union([Type.Literal("weekly"), Type.Literal("assignment")]),
        subject: Type.String({ minLength: 1, maxLength: 200 }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => toolResult(await repository.getPlan(params.kind, params.subject)),
    }),
    defineTool({
      name: "save_plan",
      label: "Save plan",
      description: "Save or replace a plan. Use kind 'weekly' with an ISO week (e.g. 2026-W38) as subject, or kind 'assignment' with the assessment's source item id as subject.",
      parameters: Type.Object({
        kind: Type.Union([Type.Literal("weekly"), Type.Literal("assignment")]),
        subject: Type.String({ minLength: 1, maxLength: 200 }),
        content: Type.String({ minLength: 1, maxLength: 8_000 }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => toolResult(await repository.savePlan(params.kind, params.subject, params.content)),
    }),
    defineTool({
      name: "remember",
      label: "Remember",
      description: "Append a dated correction or preference, verbatim, to Unicorn's memory for future reasoning.",
      parameters: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => toolResult({ result: await repository.remember(params.text) }),
    }),
  ];
}

function defineTool<TParameters extends TSchema>(tool: AgentTool<TParameters>): AgentTool<TParameters> {
  return tool;
}

function projectItemSummary(item: StoredItem) {
  return {
    source: item.source,
    itemId: item.id,
    kind: item.kind,
    title: item.title,
    timestamp: item.timestamp,
    ...(item.url ? { url: item.url } : {}),
    ...(item.body ? { body: clipText(item.body, 280), bodyTruncated: item.body.length > 280 } : {}),
  };
}

// get_item is the one tool that returns a full body: playbooks that read an
// assessment spec or a thread in full (rather than the clipped summary from
// list/search tools) need the uncapped text to plan against.
function projectFullItem(item: StoredItem | null) {
  if (!item) {
    return null;
  }
  return {
    source: item.source,
    itemId: item.id,
    kind: item.kind,
    title: item.title,
    timestamp: item.timestamp,
    ...(item.url ? { url: item.url } : {}),
    ...(item.body ? { body: item.body } : {}),
    facets: item.facets,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.archivedAt ? { archivedAt: item.archivedAt } : {}),
  };
}

function toolResult(value: unknown) {
  const text = JSON.stringify(value);
  return {
    content: [{ type: "text" as const, text }],
    details: { bytes: text.length },
  };
}

function clipText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function clipJson(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return clipText(value, 240);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(clipJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, entry]) => [key, clipJson(entry)]));
  }
  return value;
}

// Models often paste the subject line verbatim ("campus-moodle:assessment:501"
// or "campus-moodle assessment:501") as the item id; tolerate that instead of
// answering "not found" for an item that exists.
function stripSourcePrefix(source: string, itemId: string): string {
  for (const separator of [":", " "]) {
    const prefix = `${source}${separator}`;
    if (itemId.startsWith(prefix) && itemId.length > prefix.length) {
      return itemId.slice(prefix.length);
    }
  }
  return itemId;
}
