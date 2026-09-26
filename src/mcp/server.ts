import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ItemEvent, JsonValue, StoredItem } from "../kernel/types";
import { estimateTokens, MEMORY_TOKEN_CAP, type MemoryNote } from "../memory";
import type { StoredPluginManifest } from "../plugins/declarative/store";

const READ_ONLY = { destructiveHint: false, readOnlyHint: true } as const;
const WRITE = { destructiveHint: false, readOnlyHint: false } as const;

export interface ItemQuery {
  source?: string;
  kind?: string;
  limit: number;
}

export interface UpcomingQuery {
  days: number;
  includeOverdue?: boolean;
  limit: number;
}

export interface EventQuery {
  since?: string;
  limit: number;
}

export interface UpcomingItem {
  source: string;
  itemId: string;
  title: string;
  dueAt: string;
  url?: string;
  facetType: string;
  capability: string;
}

export interface ItemRelation {
  id: string;
  type: string;
  fromSource: string;
  fromItemId: string;
  toSource: string;
  toItemId: string;
  metadata: JsonValue;
  confirmedAt: string;
}

export interface LinkItemsInput {
  type: string;
  fromSource: string;
  fromItemId: string;
  toSource: string;
  toItemId: string;
  metadata: JsonValue;
}

export interface McpRepository {
  find(source: string, itemId: string): Promise<StoredItem | null>;
  listItems(query: ItemQuery): Promise<StoredItem[]>;
  listUpcoming(query: UpcomingQuery): Promise<UpcomingItem[]>;
  listEvents(query: EventQuery): Promise<ItemEvent[]>;
  listRelations(type?: string): Promise<ItemRelation[]>;
  linkItems(input: LinkItemsInput): Promise<ItemRelation>;
  listPluginManifests(): Promise<StoredPluginManifest[]>;
  putPluginManifest(manifest: unknown, enabled: boolean): Promise<StoredPluginManifest>;
  listCorrections(): Promise<MemoryNote>;
  getSyncStatus(): Promise<JsonValue | null>;
}

// ADR-0030/0034: the operator surface. Agent-job and judgment-memory tools are
// gone (no model runs in the Worker); list_corrections replaces them with a
// read of the one memory domain that is still written (verbatim, zero-LLM).
// See ./door.ts for the client-facing server mounted at /mcp.
export function createAdminMcpServer(repository: McpRepository): McpServer {
  const server = new McpServer({ name: "unicorn-admin", version: "0.1.0" });

  server.registerTool(
    "list_items",
    {
      annotations: READ_ONLY,
      description:
        "List normalized items from every enabled source, newest first. Returns summaries without the raw source payload — use get_item for the full record. Built-in sources: 'campus-moodle' (kinds: course, assessment), 'campus-ed' (kinds: course, thread); declarative plugins use their manifest id. An unknown source or kind returns an empty list.",
      inputSchema: {
        source: z.string().trim().min(1).optional(),
        kind: z.string().trim().min(1).optional(),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
    },
    async ({ source, kind, limit }) => {
      const items = await repository.listItems({ source, kind, limit });
      // Projection, not dump: strip raw payloads entirely and clip bodies (an Ed
      // thread body is unbounded prose). get_item returns the full record.
      return jsonResult(
        items.map(({ raw: _raw, ...item }) => ({
          ...item,
          ...(item.body && item.body.length > 280 ? { body: `${item.body.slice(0, 279)}…`, bodyTruncated: true } : {}),
        })),
      );
    },
  );

  server.registerTool(
    "get_item",
    {
      annotations: READ_ONLY,
      description: "Get one normalized item with its facets and raw source payload.",
      inputSchema: {
        source: z.string().trim().min(1),
        itemId: z.string().trim().min(1),
      },
    },
    async ({ source, itemId }) => jsonResult(await repository.find(source, itemId)),
  );

  server.registerTool(
    "list_upcoming",
    {
      annotations: READ_ONLY,
      description:
        "List items with due dates (assessments, deadlines) from now until `days` ahead. Set includeOverdue to also see recently missed deadlines (up to 30 days back).",
      inputSchema: {
        days: z.number().int().positive().max(365).optional().default(14),
        includeOverdue: z.boolean().optional().default(false),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
    },
    async ({ days, includeOverdue, limit }) => jsonResult(await repository.listUpcoming({ days, includeOverdue, limit })),
  );

  server.registerTool(
    "list_changes",
    {
      annotations: READ_ONLY,
      description:
        "List item change events (ADR-0036), newest first. `since` must be an ISO 8601 UTC timestamp (e.g. 2026-07-01T00:00:00Z); other formats silently match nothing.",
      inputSchema: {
        since: z
          .string()
          .trim()
          .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/, "since must be an ISO 8601 timestamp, e.g. 2026-07-01T00:00:00Z")
          .optional(),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
    },
    async ({ since, limit }) => {
      const events = await repository.listEvents({ since, limit });
      // Projection: before/after can be arbitrarily large source values — clip
      // them to what a judgment needs.
      return jsonResult(
        events.map(({ before, after, ...event }) => ({
          ...event,
          ...(before !== null ? { before: clipJson(before) } : {}),
          ...(after !== null ? { after: clipJson(after) } : {}),
        })),
      );
    },
  );

  server.registerTool(
    "list_relations",
    {
      annotations: READ_ONLY,
      description: "List confirmed cross-source item relations.",
      inputSchema: { type: z.string().trim().min(1).optional() },
    },
    async ({ type }) => jsonResult(await repository.listRelations(type)),
  );

  server.registerTool(
    "link_items",
    {
      annotations: WRITE,
      description: "Confirm a relation between two existing items, such as the same course across sources.",
      inputSchema: {
        type: z.string().trim().min(1).optional().default("same-course"),
        fromSource: z.string().trim().min(1),
        fromItemId: z.string().trim().min(1),
        toSource: z.string().trim().min(1),
        toItemId: z.string().trim().min(1),
        metadata: z.record(z.string(), z.unknown()).optional().default({}),
      },
    },
    async ({ type, fromSource, fromItemId, toSource, toItemId, metadata }) => {
      try {
        return jsonResult(
          await repository.linkItems({
            type,
            fromSource,
            fromItemId,
            toSource,
            toItemId,
            metadata: metadata as JsonValue,
          }),
        );
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Failed to link items.");
      }
    },
  );

  server.registerTool(
    "list_plugin_manifests",
    {
      annotations: READ_ONLY,
      description: "List installed Tier-1 declarative plugin manifests.",
    },
    async () => jsonResult(await repository.listPluginManifests()),
  );

  server.registerTool(
    "put_plugin_manifest",
    {
      annotations: WRITE,
      description: "Validate and install or update a Tier-1 JSON or RSS plugin manifest.",
      inputSchema: {
        manifest: z.record(z.string(), z.unknown()),
        enabled: z.boolean().optional().default(true),
      },
    },
    async ({ manifest, enabled }) => {
      try {
        return jsonResult(await repository.putPluginManifest(manifest, enabled));
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Failed to store plugin manifest.");
      }
    },
  );

  server.registerTool(
    "get_sync_status",
    {
      annotations: READ_ONLY,
      description:
        "Summary of the most recent ingestion cycle: when it ran, per-plugin pull/ingest counts, errors, and delivery results. Use this first when data looks stale or missing.",
    },
    async () => {
      const status = await repository.getSyncStatus();
      return jsonResult(
        status ?? {
          message:
            "No sync cycle has run yet. Start the hourly scheduler (POST /schedule with ADMIN_TOKEN) or trigger one manually (POST /sync).",
        },
      );
    },
  );

  server.registerTool(
    "list_corrections",
    {
      annotations: READ_ONLY,
      description:
        "Read the corrections inbox: verbatim, dated user corrections and standing preferences (e.g. \"FIT2099 quizzes don't count toward the final grade\"), newest last. Stored zero-LLM by the door's remember tool.",
    },
    async () => {
      const note = await repository.listCorrections();
      return jsonResult({ updatedAt: note.updatedAt, tokens: estimateTokens(note.content), tokenCap: MEMORY_TOKEN_CAP, content: note.content });
    },
  );

  return server;
}

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

// Cap a JSON value's serialized size for list projections; strings keep their type.
function clipJson(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return value.length > 160 ? `${value.slice(0, 159)}…` : value;
  }
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 159)}…` : value;
}

function jsonError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: { message, type: "UNICORN_ERROR" } }) }],
    isError: true,
  };
}
