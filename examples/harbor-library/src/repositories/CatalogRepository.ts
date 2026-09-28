import { CatalogItem } from '../domain/CatalogItem';
import { InMemoryRepository } from './Repository';

export class CatalogRepository extends InMemoryRepository<CatalogItem> {
  search(query: string): CatalogItem[] {
    const needle = query.trim().toLowerCase();
    return this.all().filter(item => item.title.toLowerCase().includes(needle));
  }
}
