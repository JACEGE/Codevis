import { CatalogItem } from '../domain/CatalogItem';
import { CatalogRepository } from '../repositories/CatalogRepository';
import { CirculationService } from './CirculationService';

export interface SearchHit { item: CatalogItem; available: number; }

export class SearchService {
  constructor(private catalog: CatalogRepository, private circulation: CirculationService) {}
  search(query: string, onlyAvailable = false): SearchHit[] {
    const hits = this.catalog.search(query).map(item => ({ item, available: this.circulation.availableCopies(item.id) }));
    return onlyAvailable ? hits.filter(hit => hit.available > 0) : hits;
  }
}
