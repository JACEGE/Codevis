import { CatalogItem } from './CatalogItem';

export class Dvd extends CatalogItem {
  constructor(id: string, title: string, public runtimeMinutes: number, copies = 1) {
    super(id, title, copies);
  }
  loanDays(): number { return 7; }
  dailyFee(): number { return 1; }
}
