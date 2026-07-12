import type { Facet, IngestResult, ItemEvent, ItemInput, ItemStore, JsonValue, StoredItem } from "./types";

export class Kernel {
  constructor(
    private readonly store: ItemStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ingest(items: ItemInput[]): Promise<IngestResult> {
    validateBatch(items);
    const result: IngestResult = { created: 0, updated: 0, unchanged: 0, events: [] };

    for (const rawInput of items) {
      const input = normalizeItem(rawInput);
      const stored = await this.store.find(input.source, input.id);
      const existing = stored ? normalizeStoredItem(stored) : null;
      if (existing) {
        if (equal(existingContent(existing), input)) {
          result.unchanged += 1;
          continue;
        }

        const updatedAt = this.now().toISOString();
        const events = diffEvents(existing, input, updatedAt);
        await this.store.commit(
          { ...structuredClone(input), createdAt: existing.createdAt, updatedAt },
          events,
        );
        result.updated += 1;
        result.events.push(...events);
        continue;
      }

      const createdAt = this.now().toISOString();
      const item: StoredItem = { ...structuredClone(input), createdAt, updatedAt: createdAt };
      const event: ItemEvent = {
        id: crypto.randomUUID(),
        type: "item.created",
        source: input.source,
        itemId: input.id,
        createdAt,
      };
      await this.store.commit(item, [event]);
      result.created += 1;
      result.events.push(event);
    }

    return result;
  }
}

export class InvalidItemError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidItemError";
  }
}

function validateBatch(items: ItemInput[]): void {
  const keys = new Set<string>();
  for (const item of items) {
    if (!item.source.trim() || !item.id.trim() || !item.kind.trim() || !item.title.trim()) {
      throw new InvalidItemError("invalid_item", "Item source, id, kind, and title are required.");
    }
    if (!isTimestamp(item.timestamp)) {
      throw new InvalidItemError("invalid_timestamp", "Item timestamp must be an ISO timestamp.");
    }

    const key = `${item.source}:${item.id}`;
    if (keys.has(key)) {
      throw new InvalidItemError("duplicate_item", `Batch contains duplicate item ${key}.`);
    }
    keys.add(key);

    const facetTypes = new Set<string>();
    for (const facet of item.facets) {
      if (!facet.type.trim() || facetTypes.has(facet.type)) {
        throw new InvalidItemError("invalid_facet", `Item ${key} has an empty or duplicate facet type.`);
      }
      facetTypes.add(facet.type);

      for (const capability of facet.capabilities) {
        if (!capability.name.trim() || !capability.field.trim() || !(capability.field in facet.data)) {
          throw new InvalidItemError("invalid_capability", `Facet ${facet.type} has an invalid capability binding.`);
        }
        if (!validPrimitiveValue(capability.primitive, facet.data[capability.field])) {
          throw new InvalidItemError(
            "invalid_capability_value",
            `Capability ${capability.name} has a value incompatible with ${capability.primitive}.`,
          );
        }
      }
    }
  }
}

function validPrimitiveValue(primitive: string, value: JsonValue | undefined): boolean {
  switch (primitive) {
    case "temporal":
      return typeof value === "string" && isTimestamp(value);
    case "state":
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    case "relation":
    case "actor":
      return typeof value === "string" && value.length > 0;
    case "scalar":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return false;
  }
}

function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function diffEvents(existing: StoredItem, input: ItemInput, createdAt: string): ItemEvent[] {
  const events = diffCapabilities(existing, input, createdAt);
  const changedFields: string[] = (["kind", "title", "timestamp", "url", "body"] as const).filter(
    (field) => !equal(existing[field], input[field]),
  );

  const timestampCapabilityChanged = events.some(
    (event) => event.primitive === "temporal" && equal(event.before, existing.timestamp) && equal(event.after, input.timestamp),
  );
  if (timestampCapabilityChanged) {
    const index = changedFields.indexOf("timestamp");
    if (index !== -1) {
      changedFields.splice(index, 1);
    }
  }

  if (!equal(unboundFacetData(existing.facets), unboundFacetData(input.facets))) {
    changedFields.push("facets");
  }

  if (changedFields.length) {
    events.push({
      id: crypto.randomUUID(),
      type: "item.updated",
      source: input.source,
      itemId: input.id,
      createdAt,
      changedFields,
    });
  }

  return events;
}

function diffCapabilities(existing: StoredItem, input: ItemInput, createdAt: string): ItemEvent[] {
  const previousFacets = new Map(existing.facets.map((facet) => [facet.type, facet]));
  const events: ItemEvent[] = [];

  for (const facet of input.facets) {
    const previous = previousFacets.get(facet.type);
    for (const capability of facet.capabilities) {
      const previousCapability = previous?.capabilities.find(
        (candidate) =>
          candidate.name === capability.name &&
          candidate.primitive === capability.primitive &&
          candidate.field === capability.field,
      );
      const before = previousCapability ? previous?.data[capability.field] : undefined;
      const after = facet.data[capability.field];
      if (equal(before, after)) {
        continue;
      }

      events.push({
        id: crypto.randomUUID(),
        type: "capability.changed",
        source: input.source,
        itemId: input.id,
        createdAt,
        primitive: capability.primitive,
        capability: capability.name,
        facetType: facet.type,
        field: capability.field,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      });
    }
  }

  return events;
}

function unboundFacetData(facets: Facet[]): JsonValue {
  return facets.map((facet) => {
    const boundFields = new Set(facet.capabilities.map((capability) => capability.field));
    return {
      type: facet.type,
      data: Object.fromEntries(Object.entries(facet.data).filter(([field]) => !boundFields.has(field))),
    };
  });
}

function existingContent(item: StoredItem): ItemInput {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...content } = item;
  return content;
}

function normalizeStoredItem(item: StoredItem): StoredItem {
  return {
    ...normalizeItem(existingContent(item)),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function normalizeItem(item: ItemInput): ItemInput {
  return {
    ...structuredClone(item),
    facets: item.facets
      .map((facet) => ({
        ...structuredClone(facet),
        capabilities: [...facet.capabilities].sort((left, right) =>
          `${left.name}:${left.primitive}:${left.field}`.localeCompare(`${right.name}:${right.primitive}:${right.field}`),
        ),
      }))
      .sort((left, right) => left.type.localeCompare(right.type)),
  };
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
