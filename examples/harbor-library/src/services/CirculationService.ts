import { Loan } from '../domain/Loan';
import { CatalogRepository } from '../repositories/CatalogRepository';
import { LoanRepository } from '../repositories/LoanRepository';
import { MemberRepository } from '../repositories/MemberRepository';
import { Clock } from '../shared/Clock';
import { nextId } from '../shared/Ids';
import { assertFound, RuleViolation } from '../shared/Result';
import { FeeCalculator } from './FeeCalculator';
import { ReservationService } from './ReservationService';

export class CirculationService {
  constructor(
    private catalog: CatalogRepository,
    private members: MemberRepository,
    private loans: LoanRepository,
    private reservations: ReservationService,
    private fees: FeeCalculator,
    private clock: Clock,
  ) {}

  availableCopies(itemId: string): number {
    const item = assertFound(this.catalog.findById(itemId), 'Item', itemId);
    return item.copies - this.loans.activeForItem(itemId).length - this.reservations.heldCopies(itemId);
  }

  borrow(memberId: string, itemId: string): Loan {
    const member = assertFound(this.members.findById(memberId), 'Member', memberId);
    const item = assertFound(this.catalog.findById(itemId), 'Item', itemId);
    if (item.loanDays() === 0) throw new RuleViolation('Reference items cannot leave the library');
    if (!member.canBorrow(this.loans.activeFor(memberId).length)) throw new RuleViolation('Loan limit or fee limit reached');
    if (!this.reservations.collectIfReady(memberId, itemId) && this.availableCopies(itemId) <= 0) {
      throw new RuleViolation('No copy available');
    }
    const now = this.clock.now();
    const due = new Date(now.getTime() + item.loanDays() * 86_400_000);
    return this.loans.save(new Loan(nextId('loan'), item, member, now, due));
  }

  giveBack(loanId: string): number {
    const loan = assertFound(this.loans.findById(loanId), 'Loan', loanId);
    const now = this.clock.now();
    loan.close(now);
    const fee = this.fees.feeFor(loan, now);
    if (fee > 0) loan.member.charge(fee);
    this.reservations.promoteNext(loan.item.id);
    return fee;
  }

  renew(loanId: string): Loan {
    const loan = assertFound(this.loans.findById(loanId), 'Loan', loanId);
    if (this.reservations.queueLength(loan.item.id) > 0) throw new RuleViolation('Item is reserved by another member');
    loan.dueAt = new Date(loan.dueAt.getTime() + loan.item.loanDays() * 86_400_000);
    return this.loans.save(loan);
  }
}
