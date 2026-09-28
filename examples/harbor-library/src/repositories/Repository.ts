export interface Entity { id: string; }

export class InMemoryRepository<T extends Entity> {
  protected items = new Map<string, T>();
  findById(id: string): T | undefined { return this.items.get(id); }
  all(): T[] { return [...this.items.values()]; }
  save(item: T): T { this.items.set(item.id, item); return item; }
  remove(id: string): boolean { return this.items.delete(id); }
}
