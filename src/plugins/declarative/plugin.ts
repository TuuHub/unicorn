import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { CapabilityBinding, Facet, ItemInput, JsonValue } from "../../kernel/types";
import { courseMentionFacet, extractUnitCodes } from "../course-mention";
import type { Plugin } from "../plugin";
import { asRecord, toJson } from "../source-values";

export type ValueSpec = { path: string } | { value: JsonValue };

// Declarative-plugin auth may only reference secrets in a dedicated namespace, never
// arbitrary Worker env. A manifest is attacker-reachable (an AI generates it, or the
// MCP client installs one), so binding it to the whole env would let one malicious
// manifest exfiltrate ADMIN_TOKEN / MOODLE_SESSION / AI_API_KEY to its own URL. The
// namespace is the allowlist: only PLUGIN_SECRET_* bindings are ever resolvable.
export const PLUGIN_SECRET_PREFIX = "PLUGIN_SECRET_";

function pluginSecretBinding() {
  return z
    .string()
    .trim()
    .regex(
      new RegExp(`^${PLUGIN_SECRET_PREFIX}[A-Z0-9_]{1,64}$`),
      `Plugin auth binding must name a ${PLUGIN_SECRET_PREFIX}* secret.`,
    );
}

// Only PLUGIN_SECRET_* entries of the Worker env are exposed to declarative plugins.
export function pluginBindings(env: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => name.startsWith(PLUGIN_SECRET_PREFIX)),
  );
}

export type ManifestAuth =
  | { type: "bearer"; binding: string }
  | { type: "header"; name: string; binding: string }
  | { type: "query"; name: string; binding: string };

// Auth for a remote MCP transport is narrower than the plain HTTP form above: either
// the same PLUGIN_SECRET_* bearer binding, or an OAuth provider the platform manages
// (ADR-0033) — never an arbitrary header/query, since only these two are meaningful
// for authenticating to an MCP server.
export type TransportAuth = { type: "bearer"; binding: string } | { type: "oauth"; provider: "google" };

export interface ManifestTransport {
  type: "mcp";
  url: string;
  tool: string;
  arguments?: Record<string, JsonValue>;
  auth?: TransportAuth;
}

// A static facet reads its fields straight out of the source record. A derived facet
// is computed by the plugin runtime itself from already-mapped item fields — today
// only "course-mention", which the kernel provides so any source can attach it without
// re-implementing the unit-code regex (ADR-0033).
export interface StaticManifestFacet {
  type: string;
  fields: Record<string, ValueSpec>;
  capabilities: CapabilityBinding[];
}

export interface DerivedCourseMentionFacet {
  derive: "course-mention";
  from: Array<"title" | "body">;
}

export type ManifestFacet = StaticManifestFacet | DerivedCourseMentionFacet;

export interface MappingSpec {
  id: ValueSpec;
  kind: ValueSpec;
  title: ValueSpec;
  timestamp: ValueSpec;
  url?: ValueSpec;
  body?: ValueSpec;
  facets?: ManifestFacet[];
}

// A manifest is either the original HTTP/RSS pull (format + url) or a remote-MCP pull
// (transport). The two are mutually exclusive at the top level; everything else
// (id, name, itemsPath, mapping) is shared.
export interface PluginManifestHttp {
  version: 1;
  id: string;
  name: string;
  format: "json" | "rss";
  url: string;
  itemsPath?: string;
  auth?: ManifestAuth;
  mapping: MappingSpec;
}

export interface PluginManifestMcp {
  version: 1;
  id: string;
  name: string;
  transport: ManifestTransport;
  itemsPath?: string;
  mapping: MappingSpec;
}

export type PluginManifest = PluginManifestHttp | PluginManifestMcp;

const valueSpecSchema = z.union([
  z.object({ path: z.string().trim().min(1) }),
  z.object({ value: z.json() }),
]);

const capabilitySchema = z.object({
  name: z.string().trim().min(1),
  primitive: z.enum(["temporal", "state", "relation", "actor", "scalar"]),
  field: z.string().trim().min(1),
});

const staticFacetSchema = z.object({
  type: z.string().trim().min(1),
  fields: z.record(z.string().trim().min(1), valueSpecSchema),
  capabilities: z.array(capabilitySchema),
});

const derivedFacetSchema = z.object({
  derive: z.literal("course-mention"),
  from: z.array(z.enum(["title", "body"])).min(1),
});

const facetSchema = z.union([staticFacetSchema, derivedFacetSchema]);

const mappingSchema = z.object({
  id: valueSpecSchema,
  kind: valueSpecSchema,
  title: valueSpecSchema,
  timestamp: valueSpecSchema,
  url: valueSpecSchema.optional(),
  body: valueSpecSchema.optional(),
  facets: z.array(facetSchema).optional(),
});

const idSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const nameSchema = z.string().trim().min(1).max(100);
const httpsUrlSchema = (message: string) => z.url().refine((value) => value.startsWith("https://"), message);

const httpAuthSchema = z.union([
  z.object({ type: z.literal("bearer"), binding: pluginSecretBinding() }),
  z.object({ type: z.literal("header"), name: z.string().trim().min(1), binding: pluginSecretBinding() }),
  z.object({ type: z.literal("query"), name: z.string().trim().min(1), binding: pluginSecretBinding() }),
]);

const transportAuthSchema = z.union([
  z.object({ type: z.literal("bearer"), binding: pluginSecretBinding() }),
  z.object({ type: z.literal("oauth"), provider: z.literal("google") }),
]);

const httpManifestSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  name: nameSchema,
  format: z.enum(["json", "rss"]),
  url: httpsUrlSchema("Plugin URLs must use HTTPS."),
  itemsPath: z.string().trim().min(1).optional(),
  auth: httpAuthSchema.optional(),
  mapping: mappingSchema,
});

const mcpManifestSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  name: nameSchema,
  transport: z.object({
    type: z.literal("mcp"),
    url: httpsUrlSchema("MCP transport URLs must use HTTPS."),
    tool: z.string().trim().min(1),
    arguments: z.record(z.string(), z.json()).optional(),
    auth: transportAuthSchema.optional(),
  }),
  itemsPath: z.string().trim().min(1).optional(),
  mapping: mappingSchema,
});

export function parsePluginManifest(value: unknown): PluginManifest {
  const isMcp = Boolean(value && typeof value === "object" && "transport" in value);
  return (isMcp ? mcpManifestSchema.parse(value) : httpManifestSchema.parse(value)) as PluginManifest;
}

export type OAuthTokenSource = (pluginId: string) => Promise<string>;

// Stable error codes for the MCP pull path so the sync summary (runtime/cycle.ts)
// stays informative instead of collapsing every remote-MCP failure into one string.
export class DeclarativeMcpError extends Error {
  constructor(
    readonly code: "mcp_unauthorized" | "mcp_tool_failed" | "mcp_bad_payload",
    message: string,
  ) {
    super(message);
    this.name = "DeclarativeMcpError";
  }
}

export class DeclarativePlugin implements Plugin {
  readonly id: string;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly manifest: PluginManifest,
    private readonly bindings: Record<string, unknown>,
    fetcher?: typeof fetch,
    // Resolves a fresh OAuth access token for this plugin's id. Used only when the
    // manifest's transport auth is `{ type: "oauth" }`; the caller (runtime/cycle.ts)
    // wires this to src/oauth.ts's getAccessToken. Optional so the existing 2-arg
    // constructor call in cycle.ts keeps working untouched.
    private readonly tokenSource?: OAuthTokenSource,
  ) {
    this.id = manifest.id;
    if (fetcher) {
      this.fetcher = (input, init) => fetcher(input, init);
    } else {
      this.fetcher = globalThis.fetch.bind(globalThis);
    }
  }

  async pull(): Promise<ItemInput[]> {
    const manifest = this.manifest;
    if ("transport" in manifest) {
      return this.pullMcp(manifest.transport);
    }
    return this.pullHttp(manifest);
  }

  private async pullHttp(manifest: PluginManifestHttp): Promise<ItemInput[]> {
    const url = new URL(manifest.url);
    const headers: Record<string, string> = { Accept: manifest.format === "rss" ? "application/rss+xml" : "application/json" };
    this.applyHttpAuth(url, headers, manifest.auth);
    const response = await this.fetcher(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new Error(`Declarative plugin ${this.id} returned HTTP ${response.status}.`);
    }
    const payload = manifest.format === "rss" ? parseFeed(await response.text()) : await response.json();
    const records = manifest.itemsPath ? readPath(payload, manifest.itemsPath) : payload;
    if (!Array.isArray(records)) {
      throw new Error(`Declarative plugin ${this.id} itemsPath did not resolve to an array.`);
    }
    return records.map((record) => this.mapItem(record));
  }

  private async pullMcp(transport: ManifestTransport): Promise<ItemInput[]> {
    const headers: Record<string, string> = {};
    await this.applyTransportAuth(transport, headers);
    const client = new Client({ name: `unicorn-${this.id}`, version: "1.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(new URL(transport.url), {
      fetch: this.fetcher,
      requestInit: { headers },
    });
    let result: CallToolResult;
    try {
      await client.connect(clientTransport);
      // Cast: callTool()'s inferred type also covers a legacy `toolResult`-shaped
      // response for old servers, which this plugin does not speak.
      result = (await client.callTool({ name: transport.tool, arguments: transport.arguments ?? {} })) as CallToolResult;
    } catch (error) {
      if (isUnauthorized(error)) {
        throw new DeclarativeMcpError("mcp_unauthorized", `Declarative plugin ${this.id} was unauthorized by its MCP server.`);
      }
      throw new DeclarativeMcpError(
        "mcp_tool_failed",
        `Declarative plugin ${this.id} MCP tool call failed: ${errorText(error)}`,
      );
    } finally {
      await client.close().catch(() => {});
    }
    if (result.isError) {
      throw new DeclarativeMcpError(
        "mcp_tool_failed",
        `Declarative plugin ${this.id} MCP tool ${transport.tool} returned an error result.`,
      );
    }
    const payload = this.extractToolPayload(result, transport.tool);
    const records = this.manifest.itemsPath ? readPath(payload, this.manifest.itemsPath) : payload;
    if (!Array.isArray(records)) {
      throw new DeclarativeMcpError("mcp_bad_payload", `Declarative plugin ${this.id} itemsPath did not resolve to an array.`);
    }
    return records.map((record) => this.mapItem(record));
  }

  private extractToolPayload(result: CallToolResult, tool: string): unknown {
    if (result.structuredContent !== undefined) {
      return result.structuredContent;
    }
    const textBlock = result.content?.find(
      (block): block is { type: "text"; text: string } => block.type === "text",
    );
    if (!textBlock) {
      throw new DeclarativeMcpError("mcp_bad_payload", `Declarative plugin ${this.id} MCP tool ${tool} returned no text content.`);
    }
    try {
      return JSON.parse(textBlock.text);
    } catch {
      throw new DeclarativeMcpError("mcp_bad_payload", `Declarative plugin ${this.id} MCP tool ${tool} returned invalid JSON.`);
    }
  }

  private applyHttpAuth(url: URL, headers: Record<string, string>, auth: ManifestAuth | undefined): void {
    if (!auth) {
      return;
    }
    const secret = this.bindings[auth.binding];
    if (typeof secret !== "string" || !secret) {
      throw new Error(`Declarative plugin ${this.id} requires secret binding ${auth.binding}.`);
    }
    if (auth.type === "bearer") {
      headers.Authorization = `Bearer ${secret}`;
    } else if (auth.type === "header") {
      headers[auth.name] = secret;
    } else {
      url.searchParams.set(auth.name, secret);
    }
  }

  private async applyTransportAuth(transport: ManifestTransport, headers: Record<string, string>): Promise<void> {
    const auth = transport.auth;
    if (!auth) {
      return;
    }
    if (auth.type === "bearer") {
      const secret = this.bindings[auth.binding];
      if (typeof secret !== "string" || !secret) {
        throw new DeclarativeMcpError("mcp_unauthorized", `Declarative plugin ${this.id} requires secret binding ${auth.binding}.`);
      }
      headers.Authorization = `Bearer ${secret}`;
      return;
    }
    if (!this.tokenSource) {
      throw new DeclarativeMcpError("mcp_unauthorized", `Declarative plugin ${this.id} has no OAuth token source configured.`);
    }
    let token: string;
    try {
      token = await this.tokenSource(this.id);
    } catch {
      throw new DeclarativeMcpError("mcp_unauthorized", `Declarative plugin ${this.id} could not obtain an OAuth access token.`);
    }
    headers.Authorization = `Bearer ${token}`;
  }

  private mapItem(record: unknown): ItemInput {
    const mapping = this.manifest.mapping;
    const title = requiredString(readSpec(record, mapping.title), "title");
    const url = mapping.url ? optionalString(readSpec(record, mapping.url)) : undefined;
    const body = mapping.body ? optionalString(readSpec(record, mapping.body)) : undefined;
    const facets: Facet[] = [];
    for (const facetSpec of mapping.facets ?? []) {
      if ("derive" in facetSpec) {
        const texts = facetSpec.from.map((field) => (field === "title" ? title : body));
        const facet = courseMentionFacet(extractUnitCodes(...texts));
        if (facet) {
          facets.push(facet);
        }
        continue;
      }
      facets.push({
        type: facetSpec.type,
        data: Object.fromEntries(
          Object.entries(facetSpec.fields)
            .map(([field, spec]) => [field, readSpec(record, spec)] as const)
            .filter((entry): entry is readonly [string, JsonValue] => entry[1] !== undefined),
        ),
        capabilities: structuredClone(facetSpec.capabilities),
      });
    }
    return {
      id: requiredString(readSpec(record, mapping.id), "id"),
      source: this.id,
      kind: requiredString(readSpec(record, mapping.kind), "kind"),
      title,
      timestamp: requiredString(readSpec(record, mapping.timestamp), "timestamp"),
      ...(url ? { url } : {}),
      ...(body ? { body } : {}),
      raw: toJson(record),
      facets,
    };
  }
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 401;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseFeed(xml: string): JsonValue[] {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: true });
  const document = parser.parse(xml) as Record<string, unknown>;
  const rssItems = asArray(asRecord(asRecord(document.rss).channel).item);
  const atomItems = asArray(asRecord(document.feed).entry);
  const entries = rssItems.length ? rssItems : atomItems;
  return entries.map((entry) => {
    const item = asRecord(entry);
    const link = feedLink(item.link);
    const published = textValue(item.pubDate) || textValue(item.published) || textValue(item.updated);
    const publishedAt = new Date(published).toISOString();
    return {
      guid: textValue(item.guid) || textValue(item.id) || link,
      title: textValue(item.title),
      link,
      publishedAt,
      description: textValue(item.description) || textValue(item.summary) || textValue(item.content),
      author: textValue(item.author),
      categories: asArray(item.category).map(textValue).filter(Boolean),
    };
  });
}

function feedLink(value: unknown): string {
  if (Array.isArray(value)) {
    const alternate = value.map(asRecord).find((link) => !link["@_rel"] || link["@_rel"] === "alternate");
    return textValue(alternate?.["@_href"]);
  }
  const record = asRecord(value);
  return textValue(record["@_href"]) || textValue(value);
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  const record = asRecord(value);
  const text = record["#text"];
  return typeof text === "string" || typeof text === "number" ? String(text) : "";
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function readSpec(record: unknown, spec: ValueSpec): JsonValue | undefined {
  return "value" in spec ? spec.value : toJsonOrUndefined(readPath(record, spec.path));
}

// Dot-separated path resolution, with numeric segments indexing into arrays (e.g.
// "messages.0.subject" for the first message of a thread) — needed for MCP tool
// payloads that nest the interesting fields inside arrays (ADR-0033's Gmail preset).
function readPath(value: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (current === undefined || current === null) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function requiredString(value: JsonValue | undefined, field: string): string {
  const result = optionalString(value);
  if (!result) {
    throw new Error(`Declarative plugin mapping produced an empty ${field}.`);
  }
  return result;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function toJsonOrUndefined(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : toJson(value);
}
