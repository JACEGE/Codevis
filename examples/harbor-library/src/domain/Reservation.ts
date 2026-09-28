import { CatalogItem } from './CatalogItem';
import { Member } from './Member';

export type ReservationState = 'waiting' | 'ready' | 'collected' | 'expired';

export class Reservation {
  state: ReservationState = 'waiting';
  readyUntil?: Date;
  constructor(public id: string, public item: CatalogItem, public member: Member, public createdAt: Date) {}
  markReady(until: Date): void { this.state = 'ready'; this.readyUntil = until; }
  collect(): void { this.state = 'collected'; }
  expireIfDue(now: Date): boolean {
    if (this.state === 'ready' && this.readyUntil && now > this.readyUntil) { this.state = 'expired'; return true; }
    return false;
  }
}
