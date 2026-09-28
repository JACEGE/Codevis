import { createLibrary } from '../src/app';
import { Book, ReferenceBook } from '../src/domain/Book';
import { FixedClock } from '../src/shared/Clock';

export function borrowAndReturnLateChargesFee(): void {
  const clock = new FixedClock(new Date('2026-01-01'));
  const library = createLibrary(clock);
  library.catalog.save(new Book('b1', 'Moby Dick', 'Herman Melville', '978-0142437247'));
  const member = library.membership.register('Ada', 'ada@example.com');
  const loan = library.circulation.borrow(member.id, 'b1');
  clock.advanceDays(25);
  const fee = library.circulation.giveBack(loan.id);
  if (fee !== 1) throw new Error('expected fee 1, got ' + fee);
}

export function referenceBooksStayInside(): void {
  const library = createLibrary(new FixedClock(new Date('2026-01-01')));
  library.catalog.save(new ReferenceBook('r1', 'Atlas', 'Various', '000'));
  const member = library.membership.register('Grace', 'grace@example.com');
  try { library.circulation.borrow(member.id, 'r1'); } catch { return; }
  throw new Error('reference book was lent out');
}
