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
}

export type ItemEventType = "item.created" | "item.updated" | "capability.changed";

export interface ItemEvent {
  id: string;
  type: ItemEventType;
  source: string;
  itemId: string;
  createdAt: string;
  primitive?: Primitive;
  capability?: string;
  facetType?: string;
  field?: string;
  before?: JsonValue;
  after?: JsonValue;
  changedFields?: string[];
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
