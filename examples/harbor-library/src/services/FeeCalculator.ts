import { Loan } from '../domain/Loan';

export class FeeCalculator {
  constructor(private maxFeePerLoan = 15) {}
  feeFor(loan: Loan, now: Date): number {
    const fee = loan.daysOverdue(now) * loan.item.dailyFee();
    return Math.min(this.maxFeePerLoan, Math.round(fee * 100) / 100);
  }
}
