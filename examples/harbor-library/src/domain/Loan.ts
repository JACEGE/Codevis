import { CatalogItem } from './CatalogItem';
import { Member } from './Member';

export class Loan {
  returnedAt?: Date;
  constructor(public id: string, public item: CatalogItem, public member: Member, public borrowedAt: Date, public dueAt: Date) {}
  isOverdue(now: Date): boolean { return !this.returnedAt && now > this.dueAt; }
  daysOverdue(now: Date): number {
    const end = this.returnedAt ?? now;
    return Math.max(0, Math.ceil((end.getTime() - this.dueAt.getTime()) / 86_400_000));
  }
  close(at: Date): void { this.returnedAt = at; }
}
