export abstract class CatalogItem {
  constructor(public id: string, public title: string, public copies: number = 1) {}
  abstract loanDays(): number;
  abstract dailyFee(): number;
  label(): string { return `${this.title} (${this.id})`; }
}
