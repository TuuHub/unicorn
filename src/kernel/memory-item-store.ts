import type { ItemEvent, ItemStore, StoredItem } from "./types";

export class MemoryItemStore implements ItemStore {
  private readonly items = new Map<string, StoredItem>();
  private readonly events: ItemEvent[] = [];

  async find(source: string, itemId: string): Promise<StoredItem | null> {
    return structuredClone(this.items.get(`${source}:${itemId}`) ?? null);
  }

  async commit(item: StoredItem, events: ItemEvent[]): Promise<void> {
    this.items.set(`${item.source}:${item.id}`, structuredClone(item));
    this.events.push(...structuredClone(events));
  }

  async listEvents(): Promise<ItemEvent[]> {
    return structuredClone(this.events);
  }
}
