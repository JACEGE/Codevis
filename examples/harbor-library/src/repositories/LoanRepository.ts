import { Loan } from '../domain/Loan';
import { Reservation } from '../domain/Reservation';
import { InMemoryRepository } from './Repository';

export class LoanRepository extends InMemoryRepository<Loan> {
  activeFor(memberId: string): Loan[] {
    return this.all().filter(loan => loan.member.id === memberId && !loan.returnedAt);
  }
  activeForItem(itemId: string): Loan[] {
    return this.all().filter(loan => loan.item.id === itemId && !loan.returnedAt);
  }
  overdue(now: Date): Loan[] { return this.all().filter(loan => loan.isOverdue(now)); }
}

export class ReservationRepository extends InMemoryRepository<Reservation> {
  queueFor(itemId: string): Reservation[] {
    return this.all()
      .filter(reservation => reservation.item.id === itemId && reservation.state === 'waiting')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  readyFor(memberId: string): Reservation[] {
    return this.all().filter(reservation => reservation.member.id === memberId && reservation.state === 'ready');
  }
}
