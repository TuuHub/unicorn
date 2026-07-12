import type { ItemEvent, ItemStore, StoredItem } from "./types";

export class MemoryItemStore implements ItemStore {
  private readonly items = new Map<string, StoredItem>();
  private readonly events: ItemEvent[] = [];

  async find(source: string, itemId: string): Promise<StoredItem | null> {
    return structuredClone(this.items.get(`${source}:${itemId}`) ?? null);
  }

  async commit(item: StoredItem, events: ItemEvent[]): Promise<void> {
    const stored = structuredClone(item);
    delete stored.archivedAt;
    this.items.set(`${item.source}:${item.id}`, stored);
    this.events.push(...structuredClone(events));
  }

  async archive(source: string, itemId: string, archivedAt: string): Promise<void> {
    const item = this.items.get(`${source}:${itemId}`);
    if (item) {
      item.archivedAt = archivedAt;
    }
  }

  async listEvents(): Promise<ItemEvent[]> {
    return structuredClone(this.events);
  }
}
