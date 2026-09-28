import { CatalogItem } from './CatalogItem';

export class Book extends CatalogItem {
  constructor(id: string, title: string, public author: string, public isbn: string, copies = 1) {
    super(id, title, copies);
  }
  loanDays(): number { return 21; }
  dailyFee(): number { return 0.25; }
}

export class ReferenceBook extends Book {
  loanDays(): number { return 0; }
}
