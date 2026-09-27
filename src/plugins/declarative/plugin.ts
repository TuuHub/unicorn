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

// Planned extension (ARCHITECTURE §5, ADR-0017/0038): pagination and fan-out for
// Tier-1 HTTP/JSON sources, so most REST APIs (Canvas-shaped: paged course lists,
// per-course assignment lists) fit without a Tier-2 code plugin. Deliberately no
// expression language — three fixed shapes cover the pagination styles seen in the
// wild (GitHub/Canvas link headers, cursor APIs, plain page numbers).
export type PaginationSpec =
  | { type: "link-header"; maxPages?: number }
  | { type: "cursor"; cursorPath: string; param: string; maxPages?: number }
  | { type: "page"; param: string; start: number; maxPages?: number };

// Fan-out: fetch a parent list once, then run the main request once per parent
// element, substituting `{{<as>.<path>}}` placeholders into the main URL. Item
// mapping can reach into the current parent record with a `$parent.<path>` ValueSpec
// path (see readSpec) — the same dot-path mechanism the mapping already uses.
export interface FanOutSpec {
  from: { url: string; itemsPath?: string; pagination?: PaginationSpec };
  as: string;
  max: number;
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
  pagination?: PaginationSpec;
  fanOut?: FanOutSpec;
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

// maxPages: default 5 applied at pull time (see clampMaxPages), hard cap 10 here.
const paginationMaxPagesSchema = z.number().int().min(1).max(10).optional();

const paginationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("link-header"), maxPages: paginationMaxPagesSchema }),
  z.object({
    type: z.literal("cursor"),
    cursorPath: z.string().trim().min(1),
    param: z.string().trim().min(1),
    maxPages: paginationMaxPagesSchema,
  }),
  z.object({
    type: z.literal("page"),
    param: z.string().trim().min(1),
    start: z.number().int().min(0),
    maxPages: paginationMaxPagesSchema,
  }),
]);

const fanOutSchema = z.object({
  from: z.object({
    url: httpsUrlSchema("Fan-out source URLs must use HTTPS."),
    itemsPath: z.string().trim().min(1).optional(),
    pagination: paginationSchema.optional(),
  }),
  // A simple identifier: it appears verbatim inside `{{as.field}}` in the main URL.
  as: z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/, "fanOut.as must be a simple identifier."),
  max: z.number().int().min(1).max(20),
});

// `{{name.path}}` placeholders in a manifest URL. Matched eagerly against fanOut.as
// below so a typo'd or made-up var name fails validation instead of silently
// fetching a literal "{{course.id}}" segment.
const PLACEHOLDER_PATTERN = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z0-9_.]+)\}\}/g;

function placeholderVars(url: string): string[] {
  return Array.from(url.matchAll(PLACEHOLDER_PATTERN), (match) => match[1]);
}

const PARENT_PATH_PREFIX = "$parent.";

// Every ValueSpec path in a mapping (including facet fields), so we can reject a
// `$parent.` reference when there is no fanOut to supply a parent record.
function mappingPathSpecs(mapping: z.infer<typeof mappingSchema>): string[] {
  const specs: ValueSpec[] = [mapping.id, mapping.kind, mapping.title, mapping.timestamp];
  if (mapping.url) specs.push(mapping.url);
  if (mapping.body) specs.push(mapping.body);
  for (const facet of mapping.facets ?? []) {
    if ("fields" in facet) {
      specs.push(...Object.values(facet.fields));
    }
  }
  return specs.filter((spec): spec is { path: string } => "path" in spec).map((spec) => spec.path);
}

const httpManifestSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    name: nameSchema,
    format: z.enum(["json", "rss"]),
    url: httpsUrlSchema("Plugin URLs must use HTTPS."),
    itemsPath: z.string().trim().min(1).optional(),
    auth: httpAuthSchema.optional(),
    pagination: paginationSchema.optional(),
    fanOut: fanOutSchema.optional(),
    mapping: mappingSchema,
  })
  .superRefine((manifest, ctx) => {
    if ((manifest.pagination || manifest.fanOut) && manifest.format !== "json") {
      ctx.addIssue({ code: "custom", message: 'pagination and fanOut only support format "json".' });
    }
    const knownVar = manifest.fanOut?.as;
    for (const name of placeholderVars(manifest.url)) {
      if (name !== knownVar) {
        ctx.addIssue({ code: "custom", message: `Manifest URL references unknown placeholder var "${name}".` });
      }
    }
    const referencesParent = mappingPathSpecs(manifest.mapping).some((path) => path.startsWith(PARENT_PATH_PREFIX));
    if (referencesParent && !manifest.fanOut) {
      ctx.addIssue({ code: "custom", message: "mapping references $parent but the manifest has no fanOut." });
    }
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
  // Pagination/fan-out only make sense for a paged HTTP fetch; give a clear error
  // instead of letting zod silently drop the unknown keys on the mcp schema.
  if (isMcp && value && typeof value === "object" && ("pagination" in value || "fanOut" in value)) {
    throw new Error("pagination and fanOut are not supported on the mcp transport.");
  }
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
    if (manifest.format === "rss") {
      // RSS never paginates or fans out (the schema rejects that combination), so
      // this stays the original single-fetch path, untouched.
      const url = new URL(manifest.url);
      const headers: Record<string, string> = { Accept: "application/rss+xml" };
      this.applyHttpAuth(url, headers, manifest.auth);
      const response = await this.safeFetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        throw new Error(`Declarative plugin ${this.id} returned HTTP ${response.status}.`);
      }
      const records = parseFeed(await readLimitedText(response, this.id));
      return records.map((record) => this.mapItem(record));
    }

    const budget = new SubrequestBudget(this.id);
    if (manifest.fanOut) {
      return this.pullFanOut(manifest, manifest.fanOut, budget);
    }
    const records = await this.fetchPaginatedJson(new URL(manifest.url), manifest.auth, manifest.itemsPath, manifest.pagination, budget);
    return records.map((record) => this.mapItem(record));
  }

  private async pullFanOut(manifest: PluginManifestHttp, fanOut: FanOutSpec, budget: SubrequestBudget): Promise<ItemInput[]> {
    const parents = await this.fetchPaginatedJson(
      new URL(fanOut.from.url),
      manifest.auth,
      fanOut.from.itemsPath,
      fanOut.from.pagination,
      budget,
    );
    const items: ItemInput[] = [];
    for (const parent of parents.slice(0, fanOut.max)) {
      const mainUrl = new URL(substitutePlaceholders(manifest.url, fanOut.as, parent));
      const records = await this.fetchPaginatedJson(mainUrl, manifest.auth, manifest.itemsPath, manifest.pagination, budget);
      for (const record of records) {
        items.push(this.mapItem(record, parent));
      }
    }
    return items;
  }

  // Fetches one JSON resource, following `pagination` (if any) up to its maxPages
  // cap, and concatenates every page's itemsPath-resolved records before mapping.
  // Shared by the plain pull, fan-out's parent-list fetch, and fan-out's per-parent
  // main fetch — all three are "one paginated JSON list", just with different URLs.
  private async fetchPaginatedJson(
    initialUrl: URL,
    auth: ManifestAuth | undefined,
    itemsPath: string | undefined,
    pagination: PaginationSpec | undefined,
    budget: SubrequestBudget,
  ): Promise<unknown[]> {
    const baseOrigin = initialUrl.origin;
    const maxPages = pagination ? Math.min(pagination.maxPages ?? 5, 10) : 1;
    const records: unknown[] = [];
    let nextUrl: URL | null = initialUrl;
    let pageParam = pagination?.type === "page" ? pagination.start : undefined;

    for (let page = 0; page < maxPages && nextUrl; page++) {
      const url = new URL(nextUrl);
      if (pagination?.type === "page") {
        url.searchParams.set(pagination.param, String(pageParam));
      }
      const headers: Record<string, string> = { Accept: "application/json" };
      this.applyHttpAuth(url, headers, auth);
      budget.consume();
      const response = await this.safeFetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        throw new Error(`Declarative plugin ${this.id} returned HTTP ${response.status}.`);
      }
      const payload = JSON.parse(await readLimitedText(response, this.id));
      const pageRecords = itemsPath ? readPath(payload, itemsPath) : payload;
      if (!Array.isArray(pageRecords)) {
        throw new Error(`Declarative plugin ${this.id} itemsPath did not resolve to an array.`);
      }
      if (pagination?.type === "page" && pageRecords.length === 0) {
        break;
      }
      records.push(...pageRecords);
      if (!pagination) {
        break;
      }
      nextUrl = this.resolveNextPageUrl(pagination, response, payload, url, baseOrigin);
      if (pagination.type === "page") {
        pageParam = (pageParam ?? pagination.start) + 1;
      }
    }
    return records;
  }

  private resolveNextPageUrl(pagination: PaginationSpec, response: Response, payload: unknown, currentUrl: URL, baseOrigin: string): URL | null {
    if (pagination.type === "page") {
      return currentUrl; // param/increment handled by the caller; loop stops on an empty page or maxPages.
    }
    if (pagination.type === "cursor") {
      const next = readPath(payload, pagination.cursorPath);
      if (next === undefined || next === null || next === "") {
        return null;
      }
      const url = new URL(currentUrl);
      url.searchParams.set(pagination.param, String(next));
      return url;
    }
    // link-header: the *response* names the next URL, so it is untrusted input —
    // refuse anything off the manifest's origin rather than forward the auth header
    // to a host the manifest never declared (SSRF / credential-leak guard).
    const link = response.headers.get("Link") ?? response.headers.get("link");
    const next = link ? parseLinkHeaderNext(link, currentUrl) : null;
    if (!next) {
      return null;
    }
    if (next.origin !== baseOrigin) {
      throw new Error(`Declarative plugin ${this.id} refused a pagination link to a different origin (${next.origin}).`);
    }
    return next;
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

  // Wraps this.fetcher so a network-level failure (DNS, TLS, timeout, a
  // connection reset, ...) can never carry the request URL out through
  // Error.message. applyHttpAuth's "query" auth type puts the plugin's
  // secret directly in that URL's query string, and the scheduler's alarm()
  // handler (src/runtime/cycle.ts, ADR-0035) logs any pull failure's
  // error.message verbatim as low-sensitivity observability data — a fetch
  // implementation that happens to echo the request URL in a thrown error
  // would otherwise leak the secret into those logs. HTTP-level failures
  // (response.ok false) are unaffected: those already throw a fixed,
  // URL-free message right after this call.
  private async safeFetch(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(url, init);
    } catch {
      throw new Error(`Declarative plugin ${this.id} request failed.`);
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

  // `parent` is the current fan-out parent record (undefined outside fan-out); a
  // mapping ValueSpec path prefixed `$parent.` reads from it instead of `record`.
  private mapItem(record: unknown, parent?: unknown): ItemInput {
    const mapping = this.manifest.mapping;
    const title = requiredString(readSpec(record, mapping.title, parent), "title");
    const url = mapping.url ? optionalString(readSpec(record, mapping.url, parent)) : undefined;
    const body = mapping.body ? optionalString(readSpec(record, mapping.body, parent)) : undefined;
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
            .map(([field, spec]) => [field, readSpec(record, spec, parent)] as const)
            .filter((entry): entry is readonly [string, JsonValue] => entry[1] !== undefined),
        ),
        capabilities: structuredClone(facetSpec.capabilities),
      });
    }
    return {
      id: requiredString(readSpec(record, mapping.id, parent), "id"),
      source: this.id,
      kind: requiredString(readSpec(record, mapping.kind, parent), "kind"),
      title,
      timestamp: requiredString(readSpec(record, mapping.timestamp, parent), "timestamp"),
      ...(url ? { url } : {}),
      ...(body ? { body } : {}),
      raw: toJson(record),
      facets,
    };
  }
}

// Cloudflare Workers' free plan allows 50 subrequests per Worker invocation, shared
// across every plugin a sync cycle runs; 25 per declarative-plugin pull leaves
// headroom for the rest. `pull()`'s return type (ItemInput[]) has no channel back to
// the sync summary for a partial-result warning, and runtime/cycle.ts (which owns
// that summary) is out of scope for this change — so failing loudly, the same way an
// HTTP error or a bad itemsPath already does, is the only correct option here:
// cycle.ts already turns a pull() rejection into a per-plugin `pull:*` sync error
// instead of silently truncating a source's data.
const MAX_SUBREQUESTS_PER_PULL = 25;

class SubrequestBudget {
  private used = 0;
  constructor(private readonly pluginId: string) {}

  consume(): void {
    this.used += 1;
    if (this.used > MAX_SUBREQUESTS_PER_PULL) {
      throw new Error(
        `Declarative plugin ${this.pluginId} exceeded its subrequest budget (${MAX_SUBREQUESTS_PER_PULL} per pull).`,
      );
    }
  }
}

// A manifest's URL is whatever the user (or an AI writing a manifest for them)
// typed in — it isn't attacker-controlled in the way a redirect target is, but the
// *response* body from it is: a compromised or just misbehaving server can return
// an arbitrarily large body. Neither `response.text()` nor `response.json()` caps
// how much they'll buffer, and a Worker has a hard ~128MB memory ceiling shared
// with everything else in the request — one huge response is enough to OOM the
// whole invocation. Streaming with a running byte count, rather than trusting
// Content-Length (a hostile server can omit or lie about it), is the only way to
// actually bound this.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB: generous for a course/assignment JSON page or an RSS feed.

async function readLimitedText(response: Response, pluginId: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No streaming body available (some minimal test fetch stubs) — fall back to
    // buffering whole, then enforcing the same cap after the fact.
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`Declarative plugin ${pluginId} response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
    }
    return text;
  }
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error(`Declarative plugin ${pluginId} response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  text += decoder.decode();
  return text;
}

// RFC 8288: `<url>; rel="next", <url2>; rel="prev"`. Resolved against `base` so a
// relative next-link (some APIs emit one) still works.
function parseLinkHeaderNext(header: string, base: URL): URL | null {
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match) {
      return new URL(match[1], base);
    }
  }
  return null;
}

// Substitutes `{{<varName>.<path>}}` in a URL template with the parent record's
// field at `path`, URL-encoded. Validation already ensured every placeholder in the
// manifest names `varName`, so this never needs to fail — just recomputed per parent.
function substitutePlaceholders(template: string, varName: string, parent: unknown): string {
  return template.replace(PLACEHOLDER_PATTERN, (full, name: string, path: string) => {
    if (name !== varName) {
      return full;
    }
    const value = optionalString(toJsonOrUndefined(readPath(parent, path))) ?? "";
    return encodeURIComponent(value);
  });
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

function readSpec(record: unknown, spec: ValueSpec, parent?: unknown): JsonValue | undefined {
  if ("value" in spec) {
    return spec.value;
  }
  if (spec.path.startsWith(PARENT_PATH_PREFIX)) {
    return toJsonOrUndefined(readPath(parent, spec.path.slice(PARENT_PATH_PREFIX.length)));
  }
  return toJsonOrUndefined(readPath(record, spec.path));
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
