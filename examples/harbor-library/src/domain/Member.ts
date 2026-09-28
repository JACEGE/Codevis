export type MembershipTier = 'basic' | 'family' | 'student';

export class Member {
  outstandingFees = 0;
  constructor(public id: string, public name: string, public email: string, public tier: MembershipTier = 'basic') {}
  loanLimit(): number {
    if (this.tier === 'family') return 12;
    if (this.tier === 'student') return 8;
    return 5;
  }
  canBorrow(activeLoans: number): boolean {
    return this.outstandingFees < 10 && activeLoans < this.loanLimit();
  }
  charge(amount: number): void { this.outstandingFees += amount; }
  pay(amount: number): void { this.outstandingFees = Math.max(0, this.outstandingFees - amount); }
}
