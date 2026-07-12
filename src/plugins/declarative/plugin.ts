import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { CapabilityBinding, Facet, ItemInput, JsonValue } from "../../kernel/types";
import type { Plugin } from "../plugin";

export type ValueSpec = { path: string } | { value: JsonValue };

export type ManifestAuth =
  | { type: "bearer"; binding: string }
  | { type: "header"; name: string; binding: string }
  | { type: "query"; name: string; binding: string };

export interface ManifestFacet {
  type: string;
  fields: Record<string, ValueSpec>;
  capabilities: CapabilityBinding[];
}

export interface PluginManifest {
  version: 1;
  id: string;
  name: string;
  format: "json" | "rss";
  url: string;
  itemsPath?: string;
  auth?: ManifestAuth;
  mapping: {
    id: ValueSpec;
    kind: ValueSpec;
    title: ValueSpec;
    timestamp: ValueSpec;
    url?: ValueSpec;
    body?: ValueSpec;
    facets?: ManifestFacet[];
  };
}

const valueSpecSchema = z.union([
  z.object({ path: z.string().trim().min(1) }),
  z.object({ value: z.json() }),
]);

const capabilitySchema = z.object({
  name: z.string().trim().min(1),
  primitive: z.enum(["temporal", "state", "relation", "actor", "scalar"]),
  field: z.string().trim().min(1),
});

const manifestSchema = z.object({
  version: z.literal(1),
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(1).max(100),
  format: z.enum(["json", "rss"]),
  url: z.url().refine((value) => value.startsWith("https://"), "Plugin URLs must use HTTPS."),
  itemsPath: z.string().trim().min(1).optional(),
  auth: z
    .union([
      z.object({ type: z.literal("bearer"), binding: z.string().trim().min(1) }),
      z.object({ type: z.literal("header"), name: z.string().trim().min(1), binding: z.string().trim().min(1) }),
      z.object({ type: z.literal("query"), name: z.string().trim().min(1), binding: z.string().trim().min(1) }),
    ])
    .optional(),
  mapping: z.object({
    id: valueSpecSchema,
    kind: valueSpecSchema,
    title: valueSpecSchema,
    timestamp: valueSpecSchema,
    url: valueSpecSchema.optional(),
    body: valueSpecSchema.optional(),
    facets: z
      .array(
        z.object({
          type: z.string().trim().min(1),
          fields: z.record(z.string().trim().min(1), valueSpecSchema),
          capabilities: z.array(capabilitySchema),
        }),
      )
      .optional(),
  }),
});

export function parsePluginManifest(value: unknown): PluginManifest {
  return manifestSchema.parse(value) as PluginManifest;
}

export class DeclarativePlugin implements Plugin {
  readonly id: string;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly manifest: PluginManifest,
    private readonly bindings: Record<string, unknown>,
    fetcher?: typeof fetch,
  ) {
    this.id = manifest.id;
    if (fetcher) {
      this.fetcher = (input, init) => fetcher(input, init);
    } else {
      this.fetcher = globalThis.fetch.bind(globalThis);
    }
  }

  async pull(): Promise<ItemInput[]> {
    const url = new URL(this.manifest.url);
    const headers: Record<string, string> = { Accept: this.manifest.format === "rss" ? "application/rss+xml" : "application/json" };
    this.applyAuth(url, headers);
    const response = await this.fetcher(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new Error(`Declarative plugin ${this.id} returned HTTP ${response.status}.`);
    }
    const payload = this.manifest.format === "rss" ? parseFeed(await response.text()) : await response.json();
    const records = this.manifest.itemsPath ? readPath(payload, this.manifest.itemsPath) : payload;
    if (!Array.isArray(records)) {
      throw new Error(`Declarative plugin ${this.id} itemsPath did not resolve to an array.`);
    }
    return records.map((record) => this.mapItem(record));
  }

  private applyAuth(url: URL, headers: Record<string, string>): void {
    const auth = this.manifest.auth;
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

  private mapItem(record: unknown): ItemInput {
    const mapping = this.manifest.mapping;
    const facets: Facet[] = (mapping.facets ?? []).map((facet) => ({
      type: facet.type,
      data: Object.fromEntries(
        Object.entries(facet.fields)
          .map(([field, spec]) => [field, readSpec(record, spec)] as const)
          .filter((entry): entry is readonly [string, JsonValue] => entry[1] !== undefined),
      ),
      capabilities: structuredClone(facet.capabilities),
    }));
    const url = mapping.url ? optionalString(readSpec(record, mapping.url)) : undefined;
    const body = mapping.body ? optionalString(readSpec(record, mapping.body)) : undefined;
    return {
      id: requiredString(readSpec(record, mapping.id), "id"),
      source: this.id,
      kind: requiredString(readSpec(record, mapping.kind), "kind"),
      title: requiredString(readSpec(record, mapping.title), "title"),
      timestamp: requiredString(readSpec(record, mapping.timestamp), "timestamp"),
      ...(url ? { url } : {}),
      ...(body ? { body } : {}),
      raw: toJson(record),
      facets,
    };
  }
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readSpec(record: unknown, spec: ValueSpec): JsonValue | undefined {
  return "value" in spec ? spec.value : toJsonOrUndefined(readPath(record, spec.path));
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
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

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function toJsonOrUndefined(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : toJson(value);
}
