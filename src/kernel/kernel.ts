import { isStaffAuthored } from "./staff-roles";
import type { ChangeType, Facet, IngestResult, ItemEvent, ItemInput, ItemStore, JsonValue, StoredItem } from "./types";

// A capability name matching this counts as a grade change regardless of its
// primitive (a numeric mark, a letter grade, a released/withheld state).
const GRADE_CAPABILITY_PATTERN = /grade|mark|score/i;

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
        const wasArchived = Boolean(existing.archivedAt);
        if (equal(existingContent(existing), input)) {
          const events: ItemEvent[] = wasArchived ? [restoredEvent(input, this.now().toISOString())] : [];
          if (wasArchived) {
            await this.store.commit({ ...existing, archivedAt: undefined }, events);
            result.events.push(...events);
          }
          result.unchanged += 1;
          continue;
        }

        const updatedAt = this.now().toISOString();
        const events = diffEvents(existing, input, updatedAt);
        if (wasArchived) {
          events.unshift(restoredEvent(input, updatedAt));
        }
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
      const event = creationEvent(input, createdAt);
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

// A fresh item is `item.added`, unless the author is teaching staff — then it
// is `notice.posted` (topic is left null until the triage routine assigns
// one; see ADR-0034/0036).
function creationEvent(input: ItemInput, createdAt: string): ItemEvent {
  const type: ChangeType = isStaffAuthored(input.facets) ? "notice.posted" : "item.added";
  return baseEvent(input, type, createdAt);
}

function restoredEvent(input: ItemInput, createdAt: string): ItemEvent {
  return baseEvent(input, "item.restored", createdAt);
}

function baseEvent(
  input: ItemInput,
  type: ChangeType,
  createdAt: string,
  extra: Partial<Pick<ItemEvent, "field" | "before" | "after" | "topic">> = {},
): ItemEvent {
  return {
    type,
    source: input.source,
    itemId: input.id,
    kind: input.kind,
    title: input.title,
    url: input.url ?? null,
    topic: extra.topic ?? null,
    field: extra.field ?? null,
    before: extra.before ?? null,
    after: extra.after ?? null,
    createdAt,
  };
}

// The feed is typed by what a student would ask about, not by which column
// changed: a moved deadline, a released grade, or edited prose are events; a
// view-count tick, a relation, an actor, or a raw-only source change are not
// (the item still updates in the store — see diffEvents' caller).
function diffEvents(existing: StoredItem, input: ItemInput, createdAt: string): ItemEvent[] {
  const events: ItemEvent[] = [...diffCapabilities(existing, input, createdAt)];

  const titleChanged = existing.title !== input.title;
  const bodyChanged = (existing.body ?? "") !== (input.body ?? "");
  if (titleChanged || bodyChanged) {
    events.push(
      baseEvent(input, "content.changed", createdAt, {
        before: { title: existing.title, body: existing.body ?? null },
        after: { title: input.title, body: input.body ?? null },
      }),
    );
  }

  return events;
}

function diffCapabilities(existing: StoredItem, input: ItemInput, createdAt: string): ItemEvent[] {
  const previous = capabilityValues(existing.facets);
  const next = capabilityValues(input.facets);
  const events: ItemEvent[] = [];

  for (const key of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const before = previous.get(key);
    const after = next.get(key);
    if (equal(before?.value, after?.value)) {
      continue;
    }

    const binding = after ?? before!;
    const type = changeTypeForCapability(binding.capability, binding.primitive);
    if (!type) {
      // relation / actor / scalar changes are not news (ADR-0036) — the item
      // still updates in the store, just with no event.
      continue;
    }
    events.push(
      baseEvent(input, type, createdAt, {
        field: binding.capability,
        before: before?.value ?? null,
        after: after?.value ?? null,
      }),
    );
  }

  return events;
}

// Order matters: a grade-shaped capability name wins regardless of primitive
// (ADR-0036), then temporal, then other state capabilities. Relation, actor
// and scalar capabilities that are not grade-shaped produce no event.
function changeTypeForCapability(capabilityName: string, primitive: string): ChangeType | null {
  if (GRADE_CAPABILITY_PATTERN.test(capabilityName)) {
    return "grade.changed";
  }
  if (primitive === "temporal") {
    return "deadline.changed";
  }
  if (primitive === "state") {
    return "state.changed";
  }
  return null;
}

interface BoundCapabilityValue {
  primitive: string;
  capability: string;
  facetType: string;
  field: string;
  value: JsonValue;
}

function capabilityValues(facets: Facet[]): Map<string, BoundCapabilityValue> {
  const values = new Map<string, BoundCapabilityValue>();
  for (const facet of facets) {
    for (const binding of facet.capabilities) {
      const key = `${facet.type}:${binding.name}:${binding.primitive}:${binding.field}`;
      values.set(key, {
        primitive: binding.primitive,
        capability: binding.name,
        facetType: facet.type,
        field: binding.field,
        value: facet.data[binding.field]!,
      });
    }
  }
  return values;
}

function existingContent(item: StoredItem): ItemInput {
  const { archivedAt: _archivedAt, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = item;
  return content;
}

function normalizeStoredItem(item: StoredItem): StoredItem {
  return {
    ...normalizeItem(existingContent(item)),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.archivedAt ? { archivedAt: item.archivedAt } : {}),
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
