import { createLibrary } from '../src/app';
import { Dvd } from '../src/domain/Dvd';
import { FixedClock } from '../src/shared/Clock';

export function returnedItemGoesToNextReservation(): void {
  const clock = new FixedClock(new Date('2026-03-01'));
  const library = createLibrary(clock);
  library.catalog.save(new Dvd('d1', 'Metropolis', 153));
  const first = library.membership.register('Alan', 'alan@example.com');
  const second = library.membership.register('Barbara', 'barbara@example.com');
  const loan = library.circulation.borrow(first.id, 'd1');
  library.reservations.reserve(second.id, 'd1');
  library.circulation.giveBack(loan.id);
  library.circulation.borrow(second.id, 'd1');
}

export function expiredHoldsMoveOn(): void {
  const clock = new FixedClock(new Date('2026-03-01'));
  const library = createLibrary(clock);
  library.catalog.save(new Dvd('d2', 'Nosferatu', 94));
  const member = library.membership.register('Edsger', 'edsger@example.com');
  library.reservations.reserve(member.id, 'd2');
  library.reservations.promoteNext('d2');
  clock.advanceDays(4);
  if (library.reservations.expireHolds() !== 1) throw new Error('hold did not expire');
}
