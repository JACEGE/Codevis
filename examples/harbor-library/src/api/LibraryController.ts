import { CirculationService } from '../services/CirculationService';
import { MembershipService } from '../services/MembershipService';
import { ReservationService } from '../services/ReservationService';
import { SearchService } from '../services/SearchService';
import { DomainError } from '../shared/Result';

export interface Response { status: number; body: unknown; }

export class LibraryController {
  constructor(
    private search: SearchService,
    private circulation: CirculationService,
    private reservations: ReservationService,
    private membership: MembershipService,
  ) {}
  handleSearch(query: string): Response { return this.ok(this.search.search(query)); }
  handleBorrow(memberId: string, itemId: string): Response { return this.guard(() => this.circulation.borrow(memberId, itemId)); }
  handleReturn(loanId: string): Response { return this.guard(() => ({ fee: this.circulation.giveBack(loanId) })); }
  handleReserve(memberId: string, itemId: string): Response { return this.guard(() => this.reservations.reserve(memberId, itemId)); }
  handleRegister(name: string, email: string): Response { return this.guard(() => this.membership.register(name, email)); }
  private ok(body: unknown): Response { return { status: 200, body }; }
  private guard(action: () => unknown): Response {
    try { return this.ok(action()); }
    catch (error) {
      if (error instanceof DomainError) return { status: error.code === 'NOT_FOUND' ? 404 : 409, body: { error: error.message } };
      throw error;
    }
  }
}
