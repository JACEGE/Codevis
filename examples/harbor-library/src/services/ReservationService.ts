import { Reservation } from '../domain/Reservation';
import { CatalogRepository } from '../repositories/CatalogRepository';
import { ReservationRepository } from '../repositories/LoanRepository';
import { MemberRepository } from '../repositories/MemberRepository';
import { Notifier } from '../notifications/Notifier';
import { Clock } from '../shared/Clock';
import { nextId } from '../shared/Ids';
import { assertFound, RuleViolation } from '../shared/Result';

export class ReservationService {
  constructor(
    private catalog: CatalogRepository,
    private members: MemberRepository,
    private reservations: ReservationRepository,
    private notifier: Notifier,
    private clock: Clock,
    private holdDays = 3,
  ) {}

  reserve(memberId: string, itemId: string): Reservation {
    const member = assertFound(this.members.findById(memberId), 'Member', memberId);
    const item = assertFound(this.catalog.findById(itemId), 'Item', itemId);
    if (this.reservations.queueFor(itemId).some(entry => entry.member.id === memberId)) {
      throw new RuleViolation('Already reserved');
    }
    return this.reservations.save(new Reservation(nextId('res'), item, member, this.clock.now()));
  }

  queueLength(itemId: string): number { return this.reservations.queueFor(itemId).length; }

  heldCopies(itemId: string): number {
    return this.reservations.all().filter(entry => entry.item.id === itemId && entry.state === 'ready').length;
  }

  promoteNext(itemId: string): Reservation | undefined {
    const next = this.reservations.queueFor(itemId)[0];
    if (!next) return undefined;
    const until = new Date(this.clock.now().getTime() + this.holdDays * 86_400_000);
    next.markReady(until);
    this.notifier.send(next.member, 'Your reservation is ready', `${next.item.label()} is waiting for you.`);
    return this.reservations.save(next);
  }

  collectIfReady(memberId: string, itemId: string): boolean {
    const ready = this.reservations.readyFor(memberId).find(entry => entry.item.id === itemId);
    if (!ready) return false;
    ready.collect();
    this.reservations.save(ready);
    return true;
  }

  expireHolds(): number {
    const now = this.clock.now();
    const expired = this.reservations.all().filter(entry => entry.expireIfDue(now));
    expired.forEach(entry => this.promoteNext(entry.item.id));
    return expired.length;
  }
}
