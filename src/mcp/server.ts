import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ItemEvent, JsonValue, StoredItem } from "../kernel/types";
import type { AgentJob } from "../jobs/daily-digest";
import type { AgentJobRun } from "../jobs/d1-job-store";
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
  listAgentJobs(): Promise<AgentJob[]>;
  configureAgentJob(
    id: string,
    input: {
      enabled: boolean;
      model: string;
      monthlyTokenCap: number;
      scheduleHourUtc: number;
      credentialPreference: "byok";
    },
  ): Promise<AgentJob>;
  listAgentJobRuns(id: string, limit: number): Promise<AgentJobRun[]>;
}

export function createUnicornMcpServer(repository: McpRepository): McpServer {
  const server = new McpServer({ name: "unicorn", version: "0.1.0" });

  server.registerTool(
    "list_items",
    {
      annotations: READ_ONLY,
      description: "List normalized items from every enabled source.",
      inputSchema: {
        source: z.string().trim().min(1).optional(),
        kind: z.string().trim().min(1).optional(),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
    },
    async ({ source, kind, limit }) => jsonResult(await repository.listItems({ source, kind, limit })),
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
      description: "List temporal capabilities due within a number of days.",
      inputSchema: {
        days: z.number().int().positive().max(365).optional().default(14),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
    },
    async ({ days, limit }) => jsonResult(await repository.listUpcoming({ days, limit })),
  );

  server.registerTool(
    "list_changes",
    {
      annotations: READ_ONLY,
      description: "List item and capability change events, newest first.",
      inputSchema: {
        since: z.string().trim().min(1).optional(),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
    },
    async ({ since, limit }) => jsonResult(await repository.listEvents({ since, limit })),
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
    "list_agent_jobs",
    {
      annotations: READ_ONLY,
      description: "List optional server-side agent jobs and their budget configuration.",
    },
    async () => jsonResult(await repository.listAgentJobs()),
  );

  server.registerTool(
    "configure_agent_job",
    {
      annotations: WRITE,
      description: "Configure an agent job schedule, BYOK model, and monthly token cap.",
      inputSchema: {
        id: z.literal("daily-digest"),
        enabled: z.boolean(),
        model: z.string().trim().min(1).max(100),
        monthlyTokenCap: z.number().int().positive().max(100_000_000),
        scheduleHourUtc: z.number().int().min(0).max(23).optional().default(0),
        credentialPreference: z.literal("byok").optional().default("byok"),
      },
    },
    async ({ id, enabled, model, monthlyTokenCap, scheduleHourUtc, credentialPreference }) => {
      try {
        return jsonResult(
          await repository.configureAgentJob(id, {
            enabled,
            model,
            monthlyTokenCap,
            scheduleHourUtc,
            credentialPreference,
          }),
        );
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Failed to configure agent job.");
      }
    },
  );

  server.registerTool(
    "list_agent_job_runs",
    {
      annotations: READ_ONLY,
      description: "List recent outputs and actual token usage for an agent job.",
      inputSchema: {
        id: z.literal("daily-digest"),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
    },
    async ({ id, limit }) => jsonResult(await repository.listAgentJobRuns(id, limit)),
  );

  return server;
}

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function jsonError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: { message, type: "UNICORN_ERROR" } }) }],
    isError: true,
  };
}
