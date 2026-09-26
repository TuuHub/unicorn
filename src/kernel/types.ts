export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Primitive = "temporal" | "state" | "relation" | "actor" | "scalar";

export interface CapabilityBinding {
  name: string;
  primitive: Primitive;
  field: string;
}

export interface Facet {
  type: string;
  data: Record<string, JsonValue>;
  capabilities: CapabilityBinding[];
}

export interface ItemInput {
  id: string;
  source: string;
  kind: string;
  title: string;
  timestamp: string;
  url?: string;
  body?: string;
  raw: JsonValue;
  facets: Facet[];
}

export interface StoredItem extends ItemInput {
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

// Events v2 (ADR-0036): typed by what a student would ask about, not by which
// column changed. Never pruned; retention archives Items and emits
// item.archived. `changes.seq` (the D1 autoincrement id) is the cursor.
export type ChangeType =
  | "item.added"
  | "item.archived"
  | "item.restored"
  | "deadline.changed"
  | "state.changed"
  | "grade.changed"
  | "content.changed"
  | "notice.posted";

export interface ItemEvent {
  type: ChangeType;
  source: string;
  itemId: string;
  kind: string;
  title: string;
  url: string | null;
  topic: string | null;
  field: string | null;
  before: JsonValue | null;
  after: JsonValue | null;
  createdAt: string;
}

export interface IngestResult {
  created: number;
  updated: number;
  unchanged: number;
  events: ItemEvent[];
}

export interface ItemStore {
  find(source: string, itemId: string): Promise<StoredItem | null>;
  commit(item: StoredItem, events: ItemEvent[]): Promise<void>;
}
