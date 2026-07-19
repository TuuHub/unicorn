import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ItemEvent, JsonValue, StoredItem } from "../kernel/types";
import type { AgentJob, AgentJobConfig } from "../jobs/daily-digest";
import type { AgentJobRun } from "../jobs/d1-job-store";
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
  listAgentJobs(): Promise<AgentJob[]>;
  configureAgentJob(
    id: string,
    input: AgentJobConfig,
  ): Promise<AgentJob>;
  listAgentJobRuns(id: string, limit: number): Promise<AgentJobRun[]>;
  listMemory(): Promise<MemoryNote[]>;
  getMemory(domain: string): Promise<MemoryNote>;
  saveMemory(domain: string, content: string, expectedUpdatedAt?: string): Promise<MemoryNote>;
  getSyncStatus(): Promise<JsonValue | null>;
}

export function createUnicornMcpServer(repository: McpRepository, options?: { aiConfigured?: boolean }): McpServer {
  const server = new McpServer({ name: "unicorn", version: "0.1.0" });
  const aiConfigured = options?.aiConfigured ?? true;

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
        "List item and capability change events, newest first. `since` must be an ISO 8601 UTC timestamp (e.g. 2026-07-01T00:00:00Z); other formats silently match nothing.",
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
      // Projection: the row UUID means nothing to a client, and before/after can be
      // arbitrarily large source values — clip them to what a judgment needs.
      return jsonResult(
        events.map(({ id: _id, before, after, ...event }) => ({
          ...event,
          ...(before !== undefined ? { before: clipJson(before) } : {}),
          ...(after !== undefined ? { after: clipJson(after) } : {}),
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
      description:
        "Configure an agent job's BYOK model and monthly token cap, and enable or disable it. scheduleHourUtc applies to daily-digest only (the UTC hour after which it may run once per day); triage runs every cycle and ignores it.",
      inputSchema: {
        id: z.enum(["daily-digest", "triage"]),
        enabled: z.boolean(),
        model: z.string().trim().min(1).max(100),
        monthlyTokenCap: z.number().int().positive().max(100_000_000),
        scheduleHourUtc: z.number().int().min(0).max(23).optional().default(0),
        credentialPreference: z.literal("byok").optional().default("byok"),
      },
    },
    async ({ id, enabled, model, monthlyTokenCap, scheduleHourUtc, credentialPreference }) => {
      // Enabling an LLM job with no key configured "succeeds" and then silently
      // never runs — reject it here with the fix instead.
      if (enabled && !aiConfigured) {
        return jsonError(
          `Cannot enable ${id}: no AI key is configured on the Worker. Run 'wrangler secret put AI_API_KEY' (and set AI_BASE_URL if not using OpenAI), redeploy, then retry.`,
        );
      }
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
      description:
        "List recent runs for an agent job: status, token usage, and a clipped output preview. Set fullOutput to true to include complete outputs (a digest run can be long).",
      inputSchema: {
        id: z.enum(["daily-digest", "triage"]),
        limit: z.number().int().positive().max(100).optional().default(20),
        fullOutput: z.boolean().optional().default(false),
      },
    },
    async ({ id, limit, fullOutput }) => {
      const runs = await repository.listAgentJobRuns(id, limit);
      if (fullOutput) {
        return jsonResult(runs);
      }
      return jsonResult(
        runs.map((run) => ({
          ...run,
          ...(run.output && run.output.length > 300 ? { output: `${run.output.slice(0, 299)}…`, outputTruncated: true } : {}),
        })),
      );
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
    "list_memory",
    {
      annotations: READ_ONLY,
      description:
        "List memory note summaries: domain, last update, token usage against the 4000-token cap, and a short preview. Use get_memory to read a note in full.",
    },
    async () => {
      const notes = await repository.listMemory();
      // Projection, not dump (ADR-0026): full notes can be 4k tokens each; the
      // caller only needs enough to decide which domain to open.
      return jsonResult(
        notes.map((note) => ({
          domain: note.domain,
          updatedAt: note.updatedAt,
          tokens: estimateTokens(note.content),
          tokenCap: MEMORY_TOKEN_CAP,
          preview: note.content.length > 200 ? `${note.content.slice(0, 199)}…` : note.content,
        })),
      );
    },
  );

  server.registerTool(
    "get_memory",
    {
      annotations: READ_ONLY,
      description: "Read one memory note in full by domain (for example 'preferences'). Includes token usage against the 4000-token cap.",
      inputSchema: { domain: z.string().trim().min(1).max(63) },
    },
    async ({ domain }) => {
      try {
        const note = await repository.getMemory(domain);
        return jsonResult({ ...note, tokens: estimateTokens(note.content), tokenCap: MEMORY_TOKEN_CAP });
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Failed to read memory.");
      }
    },
  );

  server.registerTool(
    "update_memory",
    {
      annotations: WRITE,
      description:
        "Rewrite a memory note in full (no partial patch — read it with get_memory first, then write the merged result). Pass ifUnmodifiedSince from get_memory's updatedAt to fail safely instead of clobbering a concurrent edit. Save empty content to delete a domain. The 4000-token cap covers ALL domains combined (every note is read in full on each triage call); at the cap, consolidate: merge duplicates, drop judgments about ended courses, keep one line per rule.",
      inputSchema: {
        domain: z.string().trim().min(1).max(63),
        content: z.string().max(20_000),
        ifUnmodifiedSince: z.string().trim().min(1).optional(),
      },
    },
    async ({ domain, content, ifUnmodifiedSince }) => {
      try {
        const note = await repository.saveMemory(domain, content, ifUnmodifiedSince);
        return jsonResult({ ...note, tokens: estimateTokens(note.content), tokenCap: MEMORY_TOKEN_CAP });
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Failed to update memory.");
      }
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
