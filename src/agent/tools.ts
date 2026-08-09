import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ItemEvent, JsonValue, StoredItem } from "../kernel/types";
import type { MemoryNote } from "../memory";
import type { EventQuery, ItemQuery, UpcomingItem, UpcomingQuery } from "../mcp/server";

export interface AgentToolRepository {
  find(source: string, itemId: string): Promise<StoredItem | null>;
  listItems(query: ItemQuery): Promise<StoredItem[]>;
  listUpcoming(query: UpcomingQuery): Promise<UpcomingItem[]>;
  listEvents(query: EventQuery): Promise<ItemEvent[]>;
  listMemory(): Promise<MemoryNote[]>;
  getSyncStatus(): Promise<JsonValue | null>;
}

export function createResidentTools(repository: AgentToolRepository): AgentTool[] {
  return [
    defineTool({
      name: "list_items",
      label: "List items",
      description: "List recent normalized Unicorn items. Use filters when the user names a source or kind.",
      parameters: Type.Object({
        source: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        kind: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const items = await repository.listItems({
          ...(params.source ? { source: params.source } : {}),
          ...(params.kind ? { kind: params.kind } : {}),
          limit: params.limit ?? 10,
        });
        return toolResult(items.map(projectItemSummary));
      },
    }),
    defineTool({
      name: "get_item",
      label: "Get item",
      description: "Read one specific normalized item after identifying its source and item id.",
      parameters: Type.Object({
        source: Type.String({ minLength: 1, maxLength: 100 }),
        itemId: Type.String({ minLength: 1, maxLength: 200 }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => toolResult(projectItem(await repository.find(params.source, params.itemId))),
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

function projectItem(item: StoredItem | null) {
  if (!item) {
    return null;
  }
  return {
    ...projectItemSummary(item),
    facets: item.facets,
    ...(item.body ? { body: clipText(item.body, 1_000), bodyTruncated: item.body.length > 1_000 } : {}),
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
